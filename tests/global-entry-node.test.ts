// Guards how the global entry reaches the machines (docs/design/knowledge-and-skills.md §4.3):
// a machine's client writes it for the executors installed there once it is connected, and
// again after the global resident knowledge changes; the host writes it for its own executors
// too; what became of each is on the machines page.
//
// What this file is here to catch:
//   - an entry that is never written on a machine, or written once and left stale after the
//     owner changed what is in force,
//   - an entry written for an executor the machine does not have,
//   - the host sending the content on every poll rather than when the machine's copy is behind,
//   - a result the owner cannot see on the machines page.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { createClient, factsOf, identityOf } from '../node/client.ts';
import type { CommandAnswer } from '../node/executors.ts';
import { questionsFrom } from '../node/executors.ts';
import { startService } from '../service/main.ts';
import type { NodeEntryReport } from '../shared/node-protocol.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { CONSOLE_DIST } from './helpers.ts';
import { create, OWNER, OWNER_SAYS } from './knowledge-helpers.ts';
const removeTree = async (dir: string): Promise<void> => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
import { signIn, until } from './stage.ts';

const USER = { actor: 'test' };

// Claude and Codex answer their version; nothing else they are asked says yes. dsh is not here.
const run = async (argv: string[]): Promise<CommandAnswer> => (argv.includes('--version') && argv.length === 2
  ? { stdout: argv[0] === 'codex' ? 'codex-cli 0.162.0\n' : '2.1.303 (Claude Code)\n', stderr: '', code: 0 }
  : { stdout: '', stderr: '', code: 1 });

test('机器连上就按装了的执行器写入口，全局常驻知识变了就改写；主机本机也写；机器页看得见', { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-entry-node-'));
  const dir = (name: string): string => join(root, name);
  const nodeEnv = { CLAUDE_CONFIG_DIR: dir('node-claude'), CODEX_HOME: dir('node-codex'), DSH_HOME: dir('node-dsh'), DSH_AGENTS_HOME: dir('node-agents') };
  // On the host, an executor counts as there when its own directory is: only Claude's is.
  const hostEnv = { CLAUDE_CONFIG_DIR: dir('host-claude'), CODEX_HOME: dir('host-codex'), DSH_HOME: dir('host-dsh'), DSH_AGENTS_HOME: dir('host-agents') };
  mkdirSync(hostEnv.CLAUDE_CONFIG_DIR, { recursive: true });
  const stop = new AbortController();
  const host = await startService({
    dataDir: dir('host-data'), port: 0, consoleDir: CONSOLE_DIST, dispatchIntervalMs: 20, watchIntervalMs: 20, outboxIntervalMs: 20, stopWaitMs: 3000,
    globalEntry: { env: hostEnv },
  });
  t.after(async () => {
    stop.abort();
    await host.stop();
    await removeTree(root);
  });
  host.settings.set('node.pollHoldMs', 5000, USER);
  // How often the host looks at its own executors again: a setting, at its shortest here.
  host.settings.set('knowledge.globalEntryCheckMs', 1000, USER);
  const base = `http://127.0.0.1:${host.port}`;
  const facts = { node_id: 'e1e2e3e4e5e6e7e8', name: 'entry-node', platform: 'test', hostname: 'entry-node.local' };
  const request = host.nodes.register(facts);
  const machine = host.nodes.approve(request.code, USER)!;
  const claimed = host.nodes.claim(request.secret);
  assert.equal(claimed.state, 'approved');
  const client = createClient({
    dataDir: dir('node-data'), origin: base, token: claimed.state === 'approved' ? claimed.token : '', facts: factsOf(identityOf(dir('node-data')), 'entry-node'), log: () => {},
    executors: { questions: questionsFrom({ claude: claudeAdapter, codex: codexAdapter }), run },
    entry: { env: nodeEnv, home: dir('node-home') },
  });
  void client.run(stop.signal).catch(() => {});

  const reported = (): NodeEntryReport | null => host.nodes.reportedEntry(machine.id);
  // Nothing in force yet: nothing written, and the machine says so for both its executors.
  const first = await until(() => (reported()?.executors.length === 2 ? reported() : undefined), '机器报告了两个执行器的入口');
  assert.deepEqual(first.executors.map(({ executor, state }) => [executor, state]), [['claude', 'cleared'], ['codex', 'cleared']]);

  host.ledger.propose(create({ title: '先分解差距', loading: 'resident' }), OWNER_SAYS, OWNER);
  const claudeFile = join(nodeEnv.CLAUDE_CONFIG_DIR, 'rules', 'tycho-knowledge.md');
  assert.equal(host.settings.get('knowledge.externalEntry'), false);
  assert.equal(existsSync(claudeFile), false);
  host.settings.set('knowledge.externalEntry', true, USER);
  await until(() => existsSync(claudeFile) && readFileSync(claudeFile, 'utf8').includes('先分解差距'), 'Claude 的入口写上了新发布的条目');
  assert.match(readFileSync(join(nodeEnv.CODEX_HOME, 'AGENTS.md'), 'utf8'), /先分解差距/);
  assert.equal(existsSync(join(nodeEnv.DSH_HOME, 'AGENTS.md')), false, '没装的执行器不写');
  const after = await until(() => (reported()?.executors.every(({ state }) => state === 'written') ? reported() : undefined), '机器报告写上了');
  assert.notEqual(after.digest, first.digest);

  // The host writes for the executors whose directory is there, and only those.
  const hostFile = join(hostEnv.CLAUDE_CONFIG_DIR, 'rules', 'tycho-knowledge.md');
  await until(() => existsSync(hostFile) && readFileSync(hostFile, 'utf8').includes('先分解差距'), '主机本机的 Claude 入口也写上了');
  assert.equal(existsSync(join(hostEnv.CODEX_HOME, 'AGENTS.md')), false);

  // The host looks again with the same content: a file taken away is written back, and an
  // executor whose directory appears since gets one — no knowledge has to change for either.
  rmSync(hostFile);
  mkdirSync(hostEnv.CODEX_HOME, { recursive: true });
  await until(() => existsSync(hostFile) && existsSync(join(hostEnv.CODEX_HOME, 'AGENTS.md')), '主机重新核实现场：撤掉的写回来，新出现的执行器也写上');
  await until(() => (host.globalEntryReport()?.executors.length === 2 ? true : undefined), '主机的报告跟着现场变');

  const page = await signIn(host);
  const machines = (await (await page.get('/api/machines')).json()) as {
    machines: { id: string; node: { entry: NodeEntryReport | null } | null }[];
    host_entry: NodeEntryReport | null;
  };
  assert.deepEqual(machines.machines.find(({ id }) => id === machine.id)?.node?.entry?.executors.map(({ state }) => state), ['written', 'written']);
  assert.deepEqual(machines.host_entry?.executors.map(({ executor, state }) => [executor, state]), [['claude', 'written'], ['codex', 'written']]);
  assert.ok(machines.machines.find(({ id }) => id === machine.id)?.node?.entry?.executors.every(({ projection }) => projection?.state === 'present'));

  host.settings.set('knowledge.externalEntry', false, USER);
  await until(() => !existsSync(claudeFile) && !existsSync(hostFile), '关闭后两处都撤下 Tycho 生成的文件');
});

test('主机只在机器的那份落后时附上入口内容，跟上了就不再发', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-entry-poll-'));
  const host = await startService({ dataDir: join(root, 'host'), port: 0, consoleDir: CONSOLE_DIST, stopWaitMs: 3000, globalEntry: { env: { CLAUDE_CONFIG_DIR: join(root, 'none') } } });
  t.after(async () => {
    await host.stop();
    await removeTree(root);
  });
  host.settings.set('node.pollHoldMs', 5000, USER);
  const request = host.nodes.register({ node_id: 'f1f2f3f4f5f6f7f8', name: 'poller', platform: 'test', hostname: 'poller.local' });
  host.nodes.approve(request.code, USER);
  const claimed = host.nodes.claim(request.secret);
  const token = claimed.state === 'approved' ? claimed.token : '';
  const poll = async (entry?: unknown): Promise<{ entry?: { digest: string; publisher?: { id: string; source?: { hostname: string; port: number } } } }> => {
    const response = await fetch(`http://127.0.0.1:${host.port}/api/node/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: NODE_PROTOCOL, cursor: null, runs: [], facts: { node_id: 'f1f2f3f4f5f6f7f8', name: 'poller', platform: 'test', hostname: 'poller.local' }, ...(entry === undefined ? {} : { entry }) }),
    });
    return (await response.json()) as { entry?: { digest: string; publisher?: { id: string; source?: { hostname: string; port: number } } } };
  };
  assert.equal((await poll()).entry, undefined, '不报入口的旧客户端什么都不给');
  const given = (await poll({ digest: null, at: new Date().toISOString(), executors: [] })).entry;
  assert.ok(given?.digest);
  assert.match(given.publisher?.id ?? '', /^[0-9a-f]{32}$/);
  assert.equal(given.publisher?.source?.port, host.port);
  assert.equal((await poll({ digest: given.digest, at: new Date().toISOString(), executors: [] })).entry, undefined, '跟上了就不再附');
});

test('publication identity persists across real isolated service restart without enabling project ownership', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-entry-restart-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'); const globalEntry = { env: { CLAUDE_CONFIG_DIR: join(root, 'no-native-profile') } };
  const first = await startService({ dataDir, port: 0, consoleDir: CONSOLE_DIST, globalEntry, stopWaitMs: 3000 });
  const id = readFileSync(join(dataDir, 'global-entry-publisher'), 'utf8'); await first.stop();
  const second = await startService({ dataDir, port: 0, consoleDir: CONSOLE_DIST, globalEntry, stopWaitMs: 3000 });
  try { assert.equal(readFileSync(join(dataDir, 'global-entry-publisher'), 'utf8'), id); assert.equal(existsSync(join(dataDir, 'project-home')), false); }
  finally { await second.stop(); }
});

test('damaged publisher degrades projection visibly while the isolated core service keeps running', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-entry-bad-publisher-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), profile = join(root, 'profile'); mkdirSync(dataDir); mkdirSync(profile);
  writeFileSync(join(dataDir, 'global-entry-publisher'), 'damaged');
  const { applyEntry, entryTargets } = await import('../node/global-entry.ts');
  applyEntry({ publisher: { id: 'a'.repeat(32) }, digest: 'a'.repeat(16), revisions: ['a@1'], text: 'known A' }, entryTargets(['claude']), { env: { CLAUDE_CONFIG_DIR: profile } });
  const path = join(profile, 'rules', 'tycho-knowledge.md'), before = readFileSync(path, 'utf8');
  const host = await startService({ dataDir, port: 0, consoleDir: CONSOLE_DIST, globalEntry: { env: { CLAUDE_CONFIG_DIR: profile } }, stopWaitMs: 3000 });
  try {
    assert.equal(host.globalEntryReport()?.executors[0]?.state, 'failed');
    assert.match(host.globalEntryReport()?.executors[0]?.note ?? '', /发布方/);
    assert.ok(host.globalEntryReport()?.executors[0]?.note?.includes(join(dataDir, 'global-entry-publisher')));
    assert.match(host.globalEntryReport()?.executors[0]?.note ?? '', /备份/);
    assert.equal(host.globalEntryReport()?.executors[0]?.projection?.state, 'present');
    assert.equal(readFileSync(path, 'utf8'), before); assert.equal(readFileSync(join(dataDir, 'global-entry-publisher'), 'utf8'), 'damaged');
    const page = await signIn(host); assert.equal((await page.get('/api/machines')).status, 200);
  } finally { await host.stop(); }
});
