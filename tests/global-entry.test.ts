// Guards the executors' own global instruction entry (docs/design/knowledge-and-skills.md §4.3,
// §4.1, §1.3) and the file tycho writes there on a machine.
//
// What this file is here to catch:
//   - an adapter declaring an entry, a way to keep a round off it, or a memory switch that the
//     recordings in tests/fixtures/global-entry do not show (a guess presented as a fact),
//   - a Worker round launched without the switch its adapter declares it is run with,
//   - a write over a file tycho did not write, or a stale file of its own left in place when
//     there is nothing (or too much) to write,
//   - a file reported as "loaded" while the executor's own rules say it is not read
//     (a higher-priority file beside it, the executor's own size cap),
//   - a symbolic link or a hard link at the entry's place followed into a file that is not tycho's,
//   - one executor whose place cannot be checked taking down the report of the others.
// (That a test never reaches the owner's real executor directories is tests/executor-dirs-guard.test.ts.)
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { compareVersions, tooOld } from '../adapters/version.ts';
import type { Turn } from '../adapters/types.ts';
import { applyEntry, checkExternalEntry, ENTRY_MARK, entryTargets, renderEntryFile, repairEntry } from '../node/global-entry.ts';
import { createClient } from '../node/client.ts';
import type { NodeEntryContent, NodeRepairEntryResult } from '../shared/node-protocol.ts';
import { globalEntryContent } from '../service/knowledge-brief.ts';
import type { Entry } from '../service/knowledge.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'global-entry');
const text = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const turn: Turn = { prompt: 'p', workdir: '.', tier: { kind: 'content', text: '{"model":"m"}' }, tierPath: 'runs/r/snapshot/tier.json' };

// ---- what each executor declares, against what was recorded ----

test('Claude：入口是配置目录下 rules 里 tycho 自己的那份；实录里同名规则文件会被加载', () => {
  const entry = claudeAdapter.globalEntry!;
  assert.deepEqual(entry.home, { env: 'CLAUDE_CONFIG_DIR', dir: '.claude' });
  assert.equal(entry.file, 'rules/tycho-knowledge.md');
  // Recorded with `claude -p /context` (2.1.303): a user-level rules file is a memory file of
  // its own, beside CLAUDE.md, and a file of this name is loaded like any other.
  const loaded = text('claude-2.1.303-win/context-default.md');
  assert.match(loaded, /\| User \| [^|]*\.claude\\rules\\this-machine\.md \|/);
  assert.match(loaded, /\| Project \| [^|]*\\rules\\tycho-knowledge\.md \|/);
});

test('Claude：不再声明单轮 offInRound 排除项，原生规则配置透传', () => {
  assert.equal(claudeAdapter.globalEntry!.offInRound, undefined);
});

test('Claude：自动记忆按原生配置透传，不在单轮注入 CLAUDE_CODE_DISABLE_AUTO_MEMORY', () => {
  const memory = claudeAdapter.memory!;
  assert.equal(memory.scope, 'shared');
  assert.equal(memory.off, undefined);
  for (const launch of [claudeAdapter.launch({ ...turn, memoryOff: true }), claudeAdapter.resume({ ...turn, memoryOff: true, sessionRef: 's' })]) {
    assert.equal(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
  }
  assert.equal(claudeAdapter.launch(turn).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
});

test('Codex：入口是 CODEX_HOME 下的 AGENTS.md，旁边的 AGENTS.override.md 有字时读那一份，空的、只有空白的不算（实录）', () => {
  const entry = codexAdapter.globalEntry!;
  assert.deepEqual(entry.home, { env: 'CODEX_HOME', dir: '.codex' });
  assert.equal(entry.file, 'AGENTS.md');
  assert.deepEqual(entry.coveredBy, [{ file: 'AGENTS.override.md', when: 'not-blank' }]);
  assert.match(text('codex-0.162.0-win/prompt-input-global.txt'), /<!-- tycho:generated -->\nMARKER-CODEX-GLOBAL/);
  const covered = text('codex-0.162.0-win/prompt-input-override.txt');
  assert.match(covered, /MARKER-CODEX-OVERRIDE/);
  assert.doesNotMatch(covered, /MARKER-CODEX-GLOBAL/);
  for (const name of ['prompt-input-override-empty.txt', 'prompt-input-override-blank.txt']) {
    assert.match(text(`codex-0.162.0-win/${name}`), /MARKER-CODEX-GLOBAL/, name);
  }
  // 60 000 bytes went in whole: no cap of its own on this file was found, so none is declared.
  assert.match(text('codex-0.162.0-win/prompt-input-big-60000.txt'), /starts true; ends true/);
  assert.equal(entry.unconfirmed, undefined);
  // Nothing keeps a round off it but another CODEX_HOME, which also holds the login.
  assert.equal(entry.offInRound, undefined);
});

test('Codex：原生记忆透传，不再声明 memory.off 或追加 --disable memories', () => {
  assert.equal(codexAdapter.memory!.scope, 'shared');
  assert.equal(codexAdapter.memory!.off, undefined);
  assert.ok(!codexAdapter.launch(turn).argv.includes('--disable'));
  assert.ok(!codexAdapter.launch({ ...turn, memoryOff: true, tier: { kind: 'content', text: 'features.memories=true' } }).argv.includes('--disable'));
  assert.ok(!codexAdapter.launch({ ...turn, memoryOff: true, readOnly: true }).argv.includes('--disable'));
  assert.equal(codexAdapter.minVersion, undefined);
});

test('dsh：入口是 DSH_HOME 下的 AGENTS.md；读不读取决于机器上的 profile（默认 64 KiB、和 ~/.agents 那份共用），声明成确认不了；关不掉、记忆说不清', () => {
  const entry = dshAdapter.globalEntry!;
  assert.deepEqual(entry.home, { env: 'DSH_HOME', dir: '.dsh' });
  assert.equal(entry.file, 'AGENTS.md');
  // The default budget is a fact of dsh-base's default profile, kept as such: not a rule the
  // writer applies by adding up file sizes.
  assert.match(entry.unconfirmed ?? '', /65 536/);
  assert.match(entry.unconfirmed ?? '', /profile/);
  const readme = text('dsh-0.2.2-rc.1/agent-instructions.README.md');
  assert.match(readme, /`\$DSH_HOME\/AGENTS\.md`, then `<agentsHome>\/AGENTS\.md`/);
  assert.match(readme, /`\$DSH_AGENTS_HOME` or `~\/\.agents`/);
  assert.match(readme, /maxBytes: 65536/);
  assert.match(readme, /harness-home file omitted before the shared-root file/);
  // The home also holds the profile a round boots: another one would not run.
  assert.equal(entry.offInRound, undefined);
  assert.equal(dshAdapter.memory!.scope, 'unknown');
  assert.equal(dshAdapter.memory!.off, undefined);
});

// ---- the file tycho writes ----

const CONTENT: NodeEntryContent = { publisher: { id: 'a'.repeat(32) }, digest: 'aaaa1111bbbb2222', revisions: ['k1@2', 'k2@1'], text: '# tycho 全局知识\n\n正文\n' };
const AT = '2026-11-10T08:00:00.000Z';

function homes(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tycho-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const geminiHome = join(root, 'gemini-home');
  const env = {
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    DSH_HOME: join(root, 'dsh'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    USERPROFILE: geminiHome,
    HOME: geminiHome,
  };
  return { root, env, targets: entryTargets() };
}
const one = (statuses: ReturnType<typeof applyEntry>, executor: string) => statuses.find((each) => each.executor === executor)!;

test('the local projection check follows readable links and keeps owner instructions intact', (t) => {
  const { root, env, targets } = homes(t);
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  const linked = join(root, 'projection.md');
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'absent' });
  applyEntry(CONTENT, targets, { env, now: AT });
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'present', revisions: CONTENT.revisions });
  writeFileSync(linked, readFileSync(path));
  rmSync(path);
  linkSync(linked, path);
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'present', revisions: CONTENT.revisions });
  writeFileSync(join(env.CODEX_HOME, 'AGENTS.override.md'), '# Owner instructions\n');
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'absent' });
  writeFileSync(join(env.CODEX_HOME, 'AGENTS.override.md'), '   ');
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'present', revisions: CONTENT.revisions });
});

test('写入口：文件头写明由 tycho 生成、勿改、正本在 tycho、修订和生成时间；三个执行器各写各的', (t) => {
  const { env, targets } = homes(t);
  const statuses = applyEntry(CONTENT, targets, { env, now: AT });
  for (const executor of ['claude', 'codex']) assert.equal(one(statuses, executor).state, 'written', executor);
  // dsh and gemini read under their own budget/profile caps: written, loading unconfirmed.
  assert.equal(one(statuses, 'dsh').state, 'unconfirmed');
  assert.equal(one(statuses, 'gemini').state, 'unconfirmed');
  assert.match(one(statuses, 'gemini').note ?? '', /24 KB|20 000/);
  assert.match(one(statuses, 'dsh').note ?? '', /profile/);
  const file = readFileSync(join(env.CLAUDE_CONFIG_DIR, 'rules', 'tycho-knowledge.md'), 'utf8');
  assert.ok(file.startsWith(`<!-- tycho:generated:v2 publisher:${'a'.repeat(32)} -->\n`));
  assert.match(file, /由 tycho 生成，勿改；正本在 tycho/);
  assert.match(file, /k1@2、k2@1/);
  assert.match(file, new RegExp(AT));
  assert.ok(file.endsWith(CONTENT.text!));
  assert.equal(readFileSync(join(env.CODEX_HOME, 'AGENTS.md'), 'utf8'), file);
  assert.equal(one(statuses, 'codex').path, join(env.CODEX_HOME, 'AGENTS.md'));
  assert.equal(renderEntryFile(CONTENT, AT), file);
});

test('写入口：不归 tycho 的文件不碰，报“被别的东西占用”', (t) => {
  const { env, targets } = homes(t);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'AGENTS.md'), '# 主人自己的指令\n');
  const statuses = applyEntry(CONTENT, targets, { env, now: AT });
  assert.equal(one(statuses, 'codex').state, 'occupied');
  assert.match(one(statuses, 'codex').note ?? '', /不是 tycho 生成的/);
  assert.equal(readFileSync(join(env.CODEX_HOME, 'AGENTS.md'), 'utf8'), '# 主人自己的指令\n');
  // Nothing to write does not make it ours to remove either.
  assert.equal(one(applyEntry({ ...CONTENT, digest: 'none', revisions: [], text: null }, targets, { env, now: AT }), 'codex').state, 'occupied');
  assert.ok(existsSync(join(env.CODEX_HOME, 'AGENTS.md')));
});

test('写入口：同一份内容不重写；内容变了重写自己的那份；没有要写的就撤下自己的那份', (t) => {
  const { env, targets } = homes(t);
  applyEntry(CONTENT, targets, { env, now: AT });
  const path = join(env.DSH_HOME, 'AGENTS.md');
  applyEntry(CONTENT, targets, { env, now: '2026-11-11T00:00:00.000Z' });
  assert.match(readFileSync(path, 'utf8'), new RegExp(AT), '同一份内容不改生成时间');
  applyEntry({ ...CONTENT, digest: 'cccc3333dddd4444', text: '# 新的\n' }, targets, { env, now: '2026-11-12T00:00:00.000Z' });
  assert.ok(readFileSync(path, 'utf8').endsWith('# 新的\n'));
  const cleared = applyEntry({ publisher: CONTENT.publisher, digest: 'eeee5555ffff6666', revisions: [], text: null, problem: '全局常驻知识合计 30.0 KiB，超过入口上限 24.0 KiB' }, targets, { env, now: AT });
  assert.equal(one(cleared, 'dsh').state, 'cleared');
  assert.match(one(cleared, 'dsh').note ?? '', /超过入口上限/);
  assert.equal(existsSync(path), false, '过时的那份撤下来，不留着让执行器照旧读');
});

test('写入口：Codex 旁边的 AGENTS.override.md 有字才算盖住，空的、只有空白的不算', (t) => {
  const { env, targets } = homes(t);
  const codex = entryTargets(['codex']);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const override = join(env.CODEX_HOME, 'AGENTS.override.md');
  writeFileSync(override, '');
  assert.equal(one(applyEntry(CONTENT, codex, { env, now: AT }), 'codex').state, 'written');
  writeFileSync(override, '  \n\t\n');
  assert.equal(one(applyEntry(CONTENT, codex, { env, now: AT }), 'codex').state, 'written');
  writeFileSync(override, '主人的覆盖\n');
  const covered = one(applyEntry(CONTENT, codex, { env, now: AT }), 'codex');
  assert.equal(covered.state, 'covered');
  assert.match(covered.note ?? '', /AGENTS\.override\.md/);
  void targets;
});

test('写入口：dsh 不按文件大小去猜它的渲染预算——两份一样的大文件也只报“加载条件未确认”', (t) => {
  const { env } = homes(t);
  mkdirSync(env.DSH_AGENTS_HOME, { recursive: true });
  const big = '# 同一份\n' + 'y'.repeat(40 * 1024);
  writeFileSync(join(env.DSH_AGENTS_HOME, 'AGENTS.md'), big);
  const status = one(applyEntry({ ...CONTENT, text: big }, entryTargets(['dsh']), { env, now: AT }), 'dsh');
  assert.equal(status.state, 'unconfirmed');
});

test('写入口：覆盖条件查不了就报“加载条件未确认”并写明原因，不当成不存在；一个执行器出事不拖垮别的', (t) => {
  const { env, targets } = homes(t);
  // A directory where the override file goes: it cannot be read as one.
  mkdirSync(join(env.CODEX_HOME, 'AGENTS.override.md'), { recursive: true });
  const statuses = applyEntry(CONTENT, targets, { env, now: AT });
  assert.deepEqual(statuses.map(({ executor }) => executor), ['claude', 'codex', 'dsh', 'gemini'], '每个执行器都有一行');
  assert.equal(one(statuses, 'codex').state, 'unconfirmed');
  assert.match(one(statuses, 'codex').note ?? '', /查不了 AGENTS\.override\.md/);
  assert.equal(one(statuses, 'claude').state, 'written');
});

test('写入口：入口是指向别处的符号链接，不碰它也不碰它指着的文件', (t) => {
  const { root, env } = homes(t);
  const elsewhere = join(root, 'owners-file.md');
  writeFileSync(elsewhere, `${ENTRY_MARK}\n主人自己链过去的\n`);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  try {
    symlinkSync(elsewhere, path, 'file');
  } catch (error) {
    t.skip(`这台机器上建不了文件符号链接：${(error as Error).message}`);
    return;
  }
  const status = one(applyEntry(CONTENT, entryTargets(['codex']), { env, now: AT }), 'codex');
  assert.equal(status.state, 'occupied');
  assert.ok(lstatSync(path).isSymbolicLink(), '链接还在');
  assert.equal(readFileSync(elsewhere, 'utf8'), `${ENTRY_MARK}\n主人自己链过去的\n`, '它指着的文件一个字没动');
  assert.equal(one(applyEntry({ ...CONTENT, text: null }, entryTargets(['codex']), { env, now: AT }), 'codex').state, 'occupied', '没有要写的也不撤');
  assert.ok(existsSync(elsewhere));
});

test('写入口：tycho 自己的文件和别处硬链接着，改写时换掉自己这一份，不改另一头', (t) => {
  const { root, env } = homes(t);
  const codex = entryTargets(['codex']);
  applyEntry(CONTENT, codex, { env, now: AT });
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  const twin = join(root, 'twin.md');
  linkSync(path, twin);
  const before = readFileSync(twin, 'utf8');
  applyEntry({ ...CONTENT, digest: 'cccc3333dddd4444', text: '# 新的\n' }, codex, { env, now: AT });
  assert.ok(readFileSync(path, 'utf8').endsWith('# 新的\n'));
  assert.equal(readFileSync(twin, 'utf8'), before, '硬链接的另一头不被原地截断改写');
});

test('写入口：写不进去如实报告，不当成写了', (t) => {
  const { env, targets } = homes(t);
  // A directory where the file goes: nothing can be written there.
  mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'rules', 'tycho-knowledge.md'), { recursive: true });
  const status = one(applyEntry(CONTENT, targets, { env, now: AT }), 'claude');
  assert.notEqual(status.state, 'written');
});

test('写入口：只写给出的那几个执行器', (t) => {
  const { env } = homes(t);
  const statuses = applyEntry(CONTENT, entryTargets(['codex']), { env, now: AT });
  assert.deepEqual(statuses.map(({ executor }) => executor), ['codex']);
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, 'rules', 'tycho-knowledge.md')), false);
});

// ---- what the host gives the machines ----

const entry = (id: string, fields: Partial<Entry> = {}): Entry => ({
  id, revision: 1, kind: 'knowledge', title: `标题${id}`, when_to_use: '什么时候', body: `正文${id}`, project_ids: null, loading: 'resident', roles: [],
  proposal_id: 'kp', published_by: 'owner', published_at: AT, reviewed_at: AT, created_at: AT, state: 'active',
  retired_at: null, retired_by: null, retired_reason: null, replaced_by: null, ...fields,
});

test('入口内容：只有全局、常驻、不限职能的条目，带一段接入说明；同样的条目同样的摘要', () => {
  const content = globalEntryContent([
    entry('k1'), entry('k2', { revision: 3 }),
    entry('k3', { loading: 'on_demand' }), entry('k4', { roles: ['review'] }), entry('k5', { project_ids: ['p'] }),
  ], 24 * 1024, { id: 'a'.repeat(32) });
  assert.deepEqual(content.revisions, ['k1@1', 'k2@3']);
  assert.match(content.text!, /get_working_context/);
  assert.match(content.text!, /propose_learning/);
  assert.match(content.text!, /标题k1（k1@1）/);
  assert.doesNotMatch(content.text!, /标题k3|标题k4|标题k5/);
  assert.equal(globalEntryContent([entry('k1'), entry('k2', { revision: 3 })], 24 * 1024, { id: 'a'.repeat(32) }).digest, content.digest);
  assert.notEqual(globalEntryContent([entry('k1')], 24 * 1024, { id: 'a'.repeat(32) }).digest, content.digest);
});

test('入口内容：没有可写的条目就是“没有要写的”；超过上限不截断、不写，说清超了多少', () => {
  const none = globalEntryContent([entry('k3', { loading: 'on_demand' })], 24 * 1024, { id: 'a'.repeat(32) });
  assert.equal(none.text, null);
  assert.equal(none.problem, undefined);
  const over = globalEntryContent([entry('k1', { body: 'x'.repeat(4000) })], 2 * 1024, { id: 'a'.repeat(32) });
  assert.equal(over.text, null);
  assert.match(over.problem ?? '', /超过上限 2\.0 KiB/);
  assert.notEqual(over.digest, none.digest);
});

// ---- repairEntry & managed section block ----

test('修复入口 coexist：在用户原有 AGENTS.md 后追加托管区块并完整保留原文，后续更新与清空只动托管区块且不回退为 occupied', (t) => {
  const { root, env } = homes(t);
  const codex = entryTargets(['codex'])[0]!;
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  const userText = '# 主人自己的全局规则\n\n- 永远保留这一段\n';
  writeFileSync(path, userText);
  const twin = join(root, 'hardlink-twin.md');
  linkSync(path, twin);

  // Automatic applyEntry still leaves untouched foreign file occupied.
  assert.equal(one(applyEntry(CONTENT, [codex], { env, now: AT }), 'codex').state, 'occupied');
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'absent' });

  // Explicit coexist appends managed section atomically without mutating hardlink twin.
  const repaired = repairEntry('coexist', CONTENT, codex, { env, now: AT });
  assert.equal(repaired.status.state, 'written');
  assert.deepEqual(repaired.status.projection, { state: 'present', revisions: CONTENT.revisions });
  assert.equal(repaired.backup_path, undefined);
  assert.equal(readFileSync(twin, 'utf8'), userText, 'coexist 不原地改写硬链接另一头');

  const afterCoexist = readFileSync(path, 'utf8');
  assert.ok(afterCoexist.startsWith(userText), '用户原有内容逐字保留');
  assert.ok(afterCoexist.includes(`<!-- tycho:managed:v2:start publisher:${'a'.repeat(32)} -->`));
  assert.ok(afterCoexist.includes(`<!-- tycho:managed:v2:end publisher:${'a'.repeat(32)} -->`));
  assert.ok(afterCoexist.includes(CONTENT.text!.trim()));
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'present', revisions: CONTENT.revisions });

  // Same content is not rewritten; updated content replaces only the managed section.
  applyEntry(CONTENT, [codex], { env, now: '2026-11-11T00:00:00.000Z' });
  assert.equal(readFileSync(path, 'utf8'), afterCoexist, '同一份内容不重写托管区块');

  const updatedContent: NodeEntryContent = {
    publisher: CONTENT.publisher,
    digest: 'cccc3333dddd4444',
    revisions: ['k3@5'],
    text: '# 新版全局知识\n\n更新后的正文\n',
  };
  const updatedStatus = one(applyEntry(updatedContent, [codex], { env, now: '2026-11-12T00:00:00.000Z' }), 'codex');
  assert.equal(updatedStatus.state, 'written');
  assert.deepEqual(updatedStatus.projection, { state: 'present', revisions: ['k3@5'] });
  const afterUpdate = readFileSync(path, 'utf8');
  assert.ok(afterUpdate.startsWith(userText), '更新后用户原有内容仍逐字保留');
  assert.ok(afterUpdate.includes('更新后的正文'));
  assert.ok(!afterUpdate.includes('# tycho 全局知识'), '旧托管正文已被替换');

  // Another publisher cannot touch our managed section.
  const otherPublisher: NodeEntryContent = { publisher: { id: 'b'.repeat(32) }, digest: 'bbbb9999', revisions: ['x@1'], text: '# 他人' };
  const blocked = one(applyEntry(otherPublisher, [codex], { env, now: AT }), 'codex');
  assert.equal(blocked.state, 'occupied');
  assert.match(blocked.note ?? '', /托管区块由其他服务占用/);
  assert.equal(readFileSync(path, 'utf8'), afterUpdate);

  // Clearing with text: null empties only the managed block body, keeps sentinel, preserves user text, never flips to occupied.
  const clearedContent: NodeEntryContent = { publisher: CONTENT.publisher, digest: 'eeee5555ffff6666', revisions: [], text: null };
  const cleared = one(applyEntry(clearedContent, [codex], { env, now: '2026-11-13T00:00:00.000Z' }), 'codex');
  assert.equal(cleared.state, 'cleared');
  assert.match(cleared.note ?? '', /已保留本机原有内容/);
  assert.deepEqual(cleared.projection, { state: 'absent' });
  assert.deepEqual(checkExternalEntry('codex', { env }), { state: 'absent' });
  const afterClear = readFileSync(path, 'utf8');
  assert.ok(afterClear.startsWith(userText), '清空后用户原有内容仍逐字保留');
  assert.ok(afterClear.includes(`<!-- tycho:managed:v2:start publisher:${'a'.repeat(32)} -->`));
  assert.ok(afterClear.includes(`<!-- tycho:managed:v2:end publisher:${'a'.repeat(32)} -->`));
  assert.ok(!afterClear.includes('更新后的正文'));

  // Future polls with text: null keep recognizing ownership and stay cleared.
  const polledAgain = one(applyEntry(clearedContent, [codex], { env, now: '2026-11-14T00:00:00.000Z' }), 'codex');
  assert.equal(polledAgain.state, 'cleared');
  assert.equal(readFileSync(path, 'utf8'), afterClear);
});

test('修复入口 coexist：拒绝原地修改符号链接并给出指向目标，链接与目标文件均不动', (t) => {
  const { root, env } = homes(t);
  const codex = entryTargets(['codex'])[0]!;
  const elsewhere = join(root, 'external-repo-agents.md');
  writeFileSync(elsewhere, '# 外部仓库指令\n');
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  try {
    symlinkSync(elsewhere, path, 'file');
  } catch (error) {
    t.skip(`这台机器上建不了文件符号链接：${(error as Error).message}`);
    return;
  }
  assert.throws(
    () => repairEntry('coexist', CONTENT, codex, { env, now: AT }),
    (err: unknown) => err instanceof Error && err.message.includes(elsewhere) && err.message.includes('备份并接管'),
  );
  assert.ok(lstatSync(path).isSymbolicLink(), '符号链接未被改动');
  assert.equal(readFileSync(elsewhere, 'utf8'), '# 外部仓库指令\n', '外部目标文件未被改动');
});

test('修复入口 backup_takeover：将已有普通文件或符号链接改名为 .pre-tycho-*.bak 完整保留，并写入 Tycho 入口', (t) => {
  const { root, env } = homes(t);
  const codex = entryTargets(['codex'])[0]!;
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  const original = '# 原来的主人配置\n重要内容\n';
  writeFileSync(path, original);

  const taken = repairEntry('backup_takeover', CONTENT, codex, { env, now: AT });
  assert.equal(taken.status.state, 'written');
  assert.deepEqual(taken.status.projection, { state: 'present', revisions: CONTENT.revisions });
  assert.ok(taken.backup_path && /\.pre-tycho-.*\.bak$/.test(taken.backup_path));
  assert.equal(readFileSync(taken.backup_path, 'utf8'), original, '备份文件内容逐字节完整');
  assert.equal(readFileSync(path, 'utf8'), renderEntryFile(CONTENT, AT));

  // Also test backup_takeover on a symlink: moves symlink aside without touching target.
  const dsh = entryTargets(['dsh'])[0]!;
  mkdirSync(env.DSH_HOME, { recursive: true });
  const dshPath = join(env.DSH_HOME, 'AGENTS.md');
  const linkedTarget = join(root, 'linked-dsh-agents.md');
  writeFileSync(linkedTarget, '# 外部链接原文\n');
  try {
    symlinkSync(linkedTarget, dshPath, 'file');
  } catch {
    return;
  }
  const takenLink = repairEntry('backup_takeover', CONTENT, dsh, { env, now: AT });
  assert.equal(takenLink.status.state, 'unconfirmed');
  assert.ok(takenLink.backup_path && lstatSync(takenLink.backup_path).isSymbolicLink(), '原符号链接被完整挪到备份路径');
  assert.equal(readFileSync(linkedTarget, 'utf8'), '# 外部链接原文\n', '符号链接指向的原文件未被修改');
  assert.equal(readFileSync(dshPath, 'utf8'), renderEntryFile(CONTENT, AT));
});

test('修复入口 resync：重新应用入口并返回最新状态；损坏的托管区块报 unknown/occupied', (t) => {
  const { env } = homes(t);
  const codex = entryTargets(['codex'])[0]!;
  const synced = repairEntry('resync', CONTENT, codex, { env, now: AT });
  assert.equal(synced.status.state, 'written');
  assert.deepEqual(synced.status.projection, { state: 'present', revisions: CONTENT.revisions });
  assert.equal(synced.backup_path, undefined);

  // Malformed managed section in user file is detected as unknown projection & occupied.
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  writeFileSync(path, `# User\n<!-- tycho:managed:v2:start publisher:${'a'.repeat(32)} -->\nmissing end\n`);
  assert.equal(checkExternalEntry('codex', { env }).state, 'unknown');
  const brokenStatus = repairEntry('resync', CONTENT, codex, { env, now: AT });
  assert.equal(brokenStatus.status.state, 'occupied');
  assert.equal(brokenStatus.status.projection?.state, 'unknown');
});

test('节点客户端 repair_entry 命令：支持 coexist 与 backup_takeover 并立即更新 entryReport', async (t) => {
  const { root, env } = homes(t);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const path = join(env.CODEX_HOME, 'AGENTS.md');
  writeFileSync(path, '# 本机自定义\n');
  const client = createClient({
    dataDir: join(root, 'node-data'),
    origin: 'http://127.0.0.1:1',
    token: 'synthetic',
    facts: { node_id: '0123456789abcdef', name: 'repair-test', platform: 'test', hostname: 'repair.local' },
    log: () => {},
    entry: { env, home: root },
  });
  const coexistRes = (await client.execute({
    id: 'cmd-1',
    kind: 'repair_entry',
    executor: 'codex',
    action: 'coexist',
    content: CONTENT,
  })) as NodeRepairEntryResult;
  assert.equal(coexistRes.status.state, 'written');
  assert.equal(coexistRes.backup_path, undefined);
  assert.equal(coexistRes.report.digest, CONTENT.digest);
  assert.equal(coexistRes.report.executors.find((each) => each.executor === 'codex')?.state, 'written');
  assert.ok(readFileSync(path, 'utf8').startsWith('# 本机自定义\n'));

  const takeoverRes = (await client.execute({
    id: 'cmd-2',
    kind: 'repair_entry',
    executor: 'codex',
    action: 'backup_takeover',
    content: CONTENT,
  })) as NodeRepairEntryResult;
  assert.equal(takeoverRes.status.state, 'written');
  assert.ok(takeoverRes.backup_path && existsSync(takeoverRes.backup_path));
  assert.equal(takeoverRes.report.executors.find((each) => each.executor === 'codex')?.state, 'written');
});
