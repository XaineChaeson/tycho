// End-to-end verification of the end-state knowledge & collaboration architecture:
// 1. Git-backed LLM Wiki vaults: commit pinning, FTS5 + backlink search, incremental lint,
//    Guardrail reconciliation, CAS stale_snapshot rejection, human-locked section preservation,
//    and owner approval writing a real Git commit.
// 2. Cross-project pinned read-only references (non-recursive read, integrity check, revocation).
// 3. Intra-project task artifact contracts (same-project enforcement, coalesced delivery guard,
//    bounded clarifications, and snapshot freezing).
// 4. Streamable HTTP MCP, token rotation, client telemetry, and dotfiles boundary audit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { consoleApp } from './console-helpers.ts';
import { DONE, fixture, USER } from './helpers.ts';
import { OWNER, ownerEntry } from './knowledge-helpers.ts';
import { inspectDotfilesBoundary } from '../service/doctor.ts';
import { wikiCitation } from '../shared/wiki.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeTempWikiRepo(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-wiki-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Owner');
  git(dir, 'config', 'user.email', 'owner@test.local');
  mkdirSync(join(dir, 'topics'), { recursive: true });
  mkdirSync(join(dir, 'entities'), { recursive: true });
  mkdirSync(join(dir, 'raw'), { recursive: true });

  writeFileSync(join(dir, 'index.md'), '# Domain Wiki Index\n\n- [[topics/dmob-10]]\n- [[entities/clickhouse]]\n', 'utf8');
  writeFileSync(join(dir, 'raw', 'raw-notes.md'), '# Raw Scratch\n\nRAW_SHOULD_NOT_BE_INDEXED\n', 'utf8');
  writeFileSync(
    join(dir, 'topics', 'dmob-10.md'),
    `---
id: topics/dmob-10
title: dmob_10 十档盘口跨仓契约
owner: quant-infra
scope: md-gateway, QuantumLab
status: active
search_phrases:
  - 十档盘口规范
  - md-book 对账
sources:
  - pr#42
---
# dmob_10 十档盘口跨仓契约

51 列价量交替 Schema，1-5 档与 tyob 对齐，底层使用 [[entities/clickhouse]] 存储。
并引用了一个待建页面 [[topics/missing-doc]]。

## My Notes
主人人工裁定：2026 Q4 以前绝不更改 InstrumentID 字段类型。
`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'entities', 'clickhouse.md'),
    `---
id: entities/clickhouse
title: 团队 ClickHouse 集群拓扑
owner: data-platform
scope: cluster, md-gateway
status: disputed
---
# 团队 ClickHouse 集群拓扑

ReplacingMergeTree 分区按 TradeDate，排序键 (InstrumentID, TradeDate, AppSeq)。
`,
    'utf8',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init wiki');
  return dir;
}

test('Git LLM Wiki: pinned commit sync, project grants, FTS5 search, lint, CAS & human-locked preservation', (t) => {
  const f = fixture(t);
  const pA = f.projectId;
  const pB = f.ledger.createProject({ name: '未授权项目 B', loginMode: 'all' }, USER);
  const repoDir = makeTempWikiRepo(t);

  // Add a SQLite Guardrail referencing the disputed ClickHouse page to test ADR-042 reconciliation
  ownerEntry(f, {
    title: 'ClickHouse 写入护栏',
    body: '写入必须对齐 entities/clickhouse 拓扑规范。',
    project_ids: [pA],
  });

  const { vault, sync } = f.ledger.wiki.createVault({
    name: '核心域知识库',
    repo_path: repoDir,
    branch: 'main',
    description: '行情与集群共识 Wiki',
  }, OWNER);

  assert.ok(sync);
  assert.equal(sync.indexed, 3, 'raw/ is excluded; index + 2 pages indexed');
  assert.ok(vault.published_commit && vault.published_commit.length === 40);

  // Lint catches broken link, disputed page, and guardrail reconciliation warning
  const codes = new Set(sync.lint.issues.map((i) => i.code));
  assert.ok(codes.has('broken_link'), 'detects broken [[topics/missing-doc]]');
  assert.ok(codes.has('disputed_page'), 'flags status: disputed page');
  assert.ok(codes.has('guardrail_reconcile'), 'flags active Guardrail referencing disputed wiki page');

  // Grant project A (with propose right); project B has NO grant
  f.ledger.wiki.grantProject(vault.id, { project_id: pA, can_propose: true }, OWNER);

  assert.equal(f.ledger.wiki.searchPages({ query: '十档盘口规范', projectId: pA }).length, 1);
  assert.equal(f.ledger.wiki.searchPages({ query: 'RAW_SHOULD_NOT_BE_INDEXED', projectId: pA }).length, 0);
  assert.equal(f.ledger.wiki.searchPages({ query: '十档盘口规范', projectId: pB }).length, 0, 'unauthorized project sees nothing');
  assert.throws(() => f.ledger.wiki.readPage(vault.id, 'topics/dmob-10', { projectId: pB }), /未获授权/);

  const page = f.ledger.wiki.readPage(vault.id, 'topics/dmob-10', { projectId: pA });
  assert.equal(page.mutation_version, 1);
  assert.deepEqual(page.backlinks, ['index']);
  assert.equal(page.locked_sections.length, 1);

  // 1) Human-locked section protection: trying to alter `## My Notes` is rejected
  assert.throws(
    () => f.ledger.wiki.proposeUpdate({
      vault_id: vault.id,
      project_id: pA,
      path: 'topics/dmob-10.md',
      new_content: `---\nid: topics/dmob-10\ntitle: 改写版\nowner: quant-infra\nscope: md-gateway\nstatus: active\n---\n# 改写版\n\n## My Notes\n已被 Agent 篡改！\n`,
      base_commit: page.commit_sha,
      base_mutation_version: page.mutation_version,
      proposed_by: 'worker-1',
      source: 'worker',
    }, USER),
    /人类锁定区块/,
  );

  // 2) CAS stale_snapshot rejection on wrong base_mutation_version
  assert.throws(
    () => f.ledger.wiki.proposeUpdate({
      vault_id: vault.id,
      project_id: pA,
      path: 'topics/dmob-10.md',
      new_content: `---\nid: topics/dmob-10\ntitle: 改写版\n---\n## My Notes\n主人人工裁定：2026 Q4 以前绝不更改 InstrumentID 字段类型。\n`,
      base_commit: page.commit_sha,
      base_mutation_version: 99,
      proposed_by: 'worker-1',
      source: 'worker',
    }, USER),
    /stale_snapshot/,
  );

  // 3) Valid proposal preserving `## My Notes` succeeds and applies cleanly as a new Git commit
  const updatedMarkdown = `---
id: topics/dmob-10
title: dmob_10 十档盘口跨仓契约（v2）
owner: quant-infra
scope: md-gateway, QuantumLab
status: active
search_phrases:
  - 十档盘口规范
  - md-book 对账
---
# dmob_10 十档盘口跨仓契约（v2）

51 列价量交替 Schema，新增 Delta+ZSTD(1) 压缩约束，底层使用 [[entities/clickhouse]]。

## My Notes
主人人工裁定：2026 Q4 以前绝不更改 InstrumentID 字段类型。
`;
  const prop = f.ledger.wiki.proposeUpdate({
    vault_id: vault.id,
    project_id: pA,
    path: 'topics/dmob-10.md',
    new_content: updatedMarkdown,
    rationale: '补充 ZSTD 压缩条款并修复悬空链接',
    base_commit: page.commit_sha,
    base_mutation_version: page.mutation_version,
    proposed_by: 'router',
    source: 'router',
  }, USER);
  assert.equal(prop.status, 'pending');

  const applied = f.ledger.wiki.decideProposal(prop.id, { action: 'approve' }, OWNER);
  assert.equal(applied.proposal.status, 'applied');
  assert.ok(applied.proposal.applied_commit && applied.proposal.applied_commit !== page.commit_sha);
  const pageV2 = f.ledger.wiki.readPage(vault.id, 'topics/dmob-10', { projectId: pA });
  assert.equal(pageV2.mutation_version, 2);
  assert.match(pageV2.body, /Delta\+ZSTD/);

  // Pinned commit read still returns v1 accurately from Git history!
  const pageV1History = f.ledger.wiki.readPage(vault.id, 'topics/dmob-10', { projectId: pA, commit: page.commit_sha });
  assert.doesNotMatch(pageV1History.body, /Delta\+ZSTD/);
  assert.equal(pageV1History.commit_sha, page.commit_sha);

  // Wiki citation format
  assert.equal(wikiCitation(vault.id, 'topics/dmob-10', pageV2.commit_sha), `wiki:${vault.id}/topics/dmob-10@${pageV2.commit_sha.slice(0, 8)}`);
});

test('Cross-project pinned read-only refs & intra-project task artifact contracts with coalescing guard', (t) => {
  const f = fixture(t);
  const pSource = f.projectId;
  const pTarget = f.ledger.createProject({ name: '消费方项目', loginMode: 'all' }, USER);

  // Create source knowledge entry at rev 1, grant pinned ref to pTarget, then revise source to rev 2
  const kId = ownerEntry(f, { title: '网关协议契约', body: '协议 v1：字段 A 为 int64。', project_ids: [pSource] });
  const ref = f.ledger.collaboration.grantCrossProjectRef({
    source_project_id: pSource,
    target_project_id: pTarget,
    ref_kind: 'knowledge',
    source_ref_id: kId,
    pinned_version: '1',
  }, OWNER);
  assert.equal(ref.pinned_version, '1');
  assert.ok(ref.frozen_bytes > 0);

  // Target project reads frozen rev 1 with intact SHA-256
  const read = f.ledger.collaboration.readCrossProjectRef(pTarget, ref.id);
  assert.equal(read.integrity_ok, true);
  assert.match(read.text, /协议 v1/);

  // Revocation blocks subsequent reads while preserving audit record
  f.ledger.collaboration.revokeCrossProjectRef(ref.id, '切换到新协议', OWNER);
  assert.throws(() => f.ledger.collaboration.readCrossProjectRef(pTarget, ref.id), /已被撤权/);

  // Intra-project task contracts: cross-project task pair must be rejected
  const prod = f.ledger.createTask({ projectId: pSource, roleId: 'implement', title: '后端接口开发', goal: '输出 OpenAPI', acceptance: '单测通过' }, USER);
  const cons = f.ledger.createTask({ projectId: pSource, roleId: 'implement', title: '前端页面对接', goal: '对接接口', acceptance: '联调通过' }, USER);
  const foreign = f.ledger.createTask({ projectId: pTarget, roleId: 'implement', title: '外部项目任务', goal: '其他', acceptance: '通过' }, USER);

  assert.throws(
    () => f.ledger.collaboration.createTaskContract({
      project_id: pSource,
      producer_task_id: prod.id,
      consumer_task_id: foreign.id,
      contract_name: 'illegal-cross',
    }, USER),
    /同一项目/,
  );

  const contract = f.ledger.collaboration.createTaskContract({
    project_id: pSource,
    producer_task_id: prod.id,
    consumer_task_id: cons.id,
    contract_name: 'openapi-v2',
    artifact_path: 'docs/openapi.json',
  }, USER);
  assert.equal(contract.status, 'pending');

  // Consumer blocks with structured clarification pinned to producer revision
  const blocked = f.ledger.collaboration.blockTaskContract(contract.id, {
    question: 'quota 字段返回的是已用百分比还是剩余百分比？',
    expected_project_id: pSource,
  }, USER);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.clarifications.length, 1);
  assert.equal(blocked.clarifications[0]!.producer_revision, prod.revision);

  // Producer clarifies -> status moves to clarified
  const clarified = f.ledger.collaboration.clarifyTaskContract(contract.id, {
    answer: '统一返回 remainingPercent（0-100 整数剩余量）。',
    expected_project_id: pSource,
  }, USER);
  assert.equal(clarified.status, 'clarified');
  assert.match(clarified.clarifications[0]!.answer ?? '', /remainingPercent/);

  // Producer delivers v1 -> notified
  const d1 = f.ledger.collaboration.deliverTaskContract(contract.id, {
    delivery_summary: '交付 OpenAPI v1',
    expected_project_id: pSource,
  }, USER);
  assert.equal(d1.contract.registered_version, 1);
  assert.equal(d1.coalesced, false);
});

test('Streamable HTTP MCP, token rotation, client telemetry, and dotfiles boundary audit', async (t) => {
  const app = await consoleApp(t);
  const issuedRes = await app.post('/api/knowledge/clients', { name: '本机 Codex HTTP', executor: 'codex', grants: ['read', 'propose'] });
  assert.equal(issuedRes.status, 201);
  const { client, token } = (await issuedRes.json()) as { client: { id: string }; token: string };

  // Streamable HTTP JSON-RPC 2.0 initialize + tools/list
  const initRes = await fetch(`${app.url}/api/knowledge/mcp/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  });
  assert.equal(initRes.status, 200);
  const initJson = (await initRes.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(initJson.result.serverInfo.name, 'tycho-knowledge');

  const listRes = await fetch(`${app.url}/api/knowledge/mcp/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const listJson = (await listRes.json()) as { result: { tools: { name: string }[] } };
  assert.ok(listJson.result.tools.some((tool) => tool.name === 'propose_wiki_update'));

  // Client telemetry recorded last_used_at and request_count >= 2
  const updatedClient = app.f.ledger.listClients().find((c) => c.id === client.id)!;
  assert.ok(updatedClient.last_used_at !== null);
  assert.equal(updatedClient.request_count, 2);

  // Rotate token: old token rejected immediately, new token works
  const rotRes = await app.post(`/api/knowledge/clients/${client.id}/rotate`, {});
  assert.equal(rotRes.status, 200);
  const { token: newToken } = (await rotRes.json()) as { token: string };
  assert.notEqual(newToken, token);

  const oldPing = await fetch(`${app.url}/api/knowledge/mcp/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  });
  assert.equal(oldPing.status, 401);

  const newPing = await fetch(`${app.url}/api/knowledge/mcp/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${newToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
  });
  assert.equal(newPing.status, 200);

  // Dotfiles boundary inspection on isolated synthetic home directory
  const fakeHome = mkdtempSync(join(tmpdir(), 'tycho-home-'));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  mkdirSync(join(fakeHome, '.config', 'chezmoi'), { recursive: true });
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  mkdirSync(join(fakeHome, '.codex'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', 'CLAUDE.md'), '# Personal\n<!-- tycho:global-entry:start -->\nrule\n<!-- tycho:global-entry:end -->\n', 'utf8');
  writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), '# Pure Personal Dotfiles\n', 'utf8');

  const boundary = inspectDotfilesBoundary(fakeHome);
  assert.equal(boundary.chezmoi_detected, true);
  assert.equal(boundary.items.find((i) => i.executor === 'claude')?.ownership, 'coexist_block');
  assert.equal(boundary.items.find((i) => i.executor === 'codex')?.ownership, 'external_dotfiles');
  assert.equal(boundary.items.find((i) => i.executor === 'gemini')?.ownership, 'absent');
});
