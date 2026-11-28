// Positive & close-negative recall regression suite + rule-first governance & JSONL portability
// tests (adapted from Octop Memory evals/recall/ methodology for Tycho's SQLite FTS5 ledger).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DONE, fixture, USER } from './helpers.ts';
import { EVIDENCE, OWNER, OWNER_SAYS, ownerEntry, WHY } from './knowledge-helpers.ts';
import { tokenizeForSearch } from '../service/search-index.ts';

test('FTS5 recall eval: 32 positive and close-negative CJK/English engineering queries', (t) => {
  const f = fixture(t);
  const p = f.projectId;
  const other = f.ledger.createProject({ name: '隔离对照组', loginMode: 'all' }, USER);

  // Seed diverse engineering knowledge cards (with and without search_phrases)
  const kMem = ownerEntry(f, {
    title: 'ClickHouse 容器内存上限排查',
    when_to_use: '容器内 ClickHouse 出现 OOM 或 max_server_memory_usage 异常放大',
    body: 'Slurm cgroup v2 将 memory.max 写在父级，导致容器读 /proc/meminfo 看到宿主机 1.1 TiB 内存。必须配合 lxcfs 虚拟化 /proc/meminfo。',
    project_ids: [p],
    search_phrases: ['ClickHouse 内存限制', 'cgroup meminfo OOM', '容器内存可见性'],
  });
  const kDmob = ownerEntry(f, {
    title: 'dmob_10 跨仓契约 51 列规范',
    when_to_use: '开发行情网关与 QuantumLab 十档盘口入库对齐',
    body: 'dmob_10 采用 ReplacingMergeTree，row_key 为 (InstrumentID, TradeDate, AppSeq)，1-5 档与 tyob 对齐，6-10 档由确定性 md-book 保障。',
    project_ids: [p],
    search_phrases: ['十档盘口 schema', 'md-gateway 契约'],
  });
  const kPy = ownerEntry(f, {
    title: '容器 Python 禁用字节码缓存',
    when_to_use: '在共享只读镜像中执行 Python 研究脚本时',
    body: '容器内执行 Python 一律加 -B 参数或设置 PYTHONDONTWRITEBYTECODE=1，防止向只读挂载目录写 __pycache__ 报错。',
    project_ids: null,
    search_phrases: ['python pycache 只读报错', 'PYTHONDONTWRITEBYTECODE'],
  });
  const kPort = ownerEntry(f, {
    title: '主控服务默认监听端口 8799',
    when_to_use: '排查主机 systemd 反向代理或控制台连接问题',
    body: 'Tycho 主控监听 127.0.0.1:8799，systemd 用户服务需要导出 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS。',
    project_ids: [p],
    search_phrases: ['tycho 端口', 'lighthouse systemd 环境变量'],
  });
  const kAuth = ownerEntry(f, {
    title: 'Codex 账号额度口径统一为剩余量',
    when_to_use: '修改用量页、账号页或左下角额度弹窗展示时',
    body: '全部额度百分比使用 remainingPercent(used)，色阶统一 <=10% 红、<=20% 琥珀、>20% 绿。',
    project_ids: [p],
    search_phrases: ['剩余额度百分比', 'quota remainingPercent'],
  });
  const kOther = ownerEntry(f, {
    title: 'ClickHouse 隔离项目私有配置',
    when_to_use: '仅适用于隔离对照组',
    body: '隔离项目的 ClickHouse 内存限制和端口 9999，绝不能泄漏到主项目检索结果。',
    project_ids: [other],
  });

  const search = (query: string, scope: 'global' | { projectId: string } = { projectId: p }) =>
    f.ledger.searchLibrary({ query, scope }).items.map((e) => e.id);

  // --- Positive cases (phrase mismatch, CJK/Latin hybrid, search_phrases, exact identifiers) ---
  const positives: [string, 'global' | { projectId: string }, string][] = [
    ['ClickHouse 内存限制', { projectId: p }, kMem],
    ['容器 OOM meminfo', { projectId: p }, kMem],
    ['lxcfs 虚拟化', { projectId: p }, kMem],
    ['cgroup v2 memory.max', { projectId: p }, kMem],
    ['容器内存可见性', { projectId: p }, kMem],
    ['dmob_10', { projectId: p }, kDmob],
    ['十档盘口 schema', { projectId: p }, kDmob],
    ['ReplacingMergeTree AppSeq', { projectId: p }, kDmob],
    ['md-gateway 契约', { projectId: p }, kDmob],
    ['InstrumentID TradeDate', { projectId: p }, kDmob],
    ['python pycache 只读报错', 'global', kPy],
    ['PYTHONDONTWRITEBYTECODE', 'global', kPy],
    ['字节码缓存', 'global', kPy],
    ['8799', { projectId: p }, kPort],
    ['tycho 端口', { projectId: p }, kPort],
    ['XDG_RUNTIME_DIR systemd', { projectId: p }, kPort],
    ['lighthouse systemd 环境变量', { projectId: p }, kPort],
    ['剩余额度百分比', { projectId: p }, kAuth],
    ['remainingPercent', { projectId: p }, kAuth],
    ['额度弹窗 色阶', { projectId: p }, kAuth],
    ['隔离项目 9999', { projectId: other }, kOther],
  ];

  for (const [query, scope, expectedId] of positives) {
    const ids = search(query, scope);
    assert.equal(ids[0], expectedId, `Positive query "${query}" expected top-1 ${expectedId}, got ${JSON.stringify(ids)}`);
  }

  // --- Close-negative controls (must return empty or NOT leak isolated scope / unrelated ports) ---
  const negatives: [string, 'global' | { projectId: string }, string][] = [
    ['Kubernetes Helm Ingress 证书自动续期', { projectId: p }, 'unrelated infra'],
    ['MySQL 主从 binlog 延迟复制调优', { projectId: p }, 'unrelated db'],
    ['React Server Components hydration mismatch', 'global', 'unrelated frontend'],
    ['端口 9999 隔离项目', { projectId: p }, 'cross-project isolation'],
    ['ClickHouse 内存限制', 'global', 'project entry must not leak into global'],
    ['9999', { projectId: p }, 'wrong port must return empty'],
    ['财务报销发票抬头税号', { projectId: p }, 'unrelated admin topic'],
    ['GPU NCCL InfiniBand 通信超时', { projectId: p }, 'unrelated cluster topic'],
    ['Postgres autovacuum freeze 调优', { projectId: p }, 'unrelated pg'],
    ['SwiftUI Metal Shader 编译报错', { projectId: p }, 'unrelated mobile'],
    ['Kafka 分区重平衡 consumer lag', { projectId: p }, 'unrelated mq'],
  ];

  for (const [query, scope, label] of negatives) {
    const ids = search(query, scope);
    assert.deepEqual(ids, [], `Negative control [${label}] "${query}" should return empty, got ${JSON.stringify(ids)}`);
  }

  // --- Snapshot-bound deduplication (`excludeIds`) ---
  const deduped = f.ledger.searchLibrary({ query: 'ClickHouse 内存限制', scope: { projectId: p }, excludeIds: [kMem] }).items;
  assert.deepEqual(deduped, [], 'snapshot-bound excludeIds suppresses already-injected knowledge');

  // --- CJK + Latin tokenizer sanity ---
  const toks = tokenizeForSearch('ClickHouse 内存限制 dmob_10');
  assert.ok(toks.includes('clickhouse') && toks.includes('dmob_10') && toks.includes('dmob') && toks.includes('内存') && toks.includes('限制'));
});

test('rule-first pre-filter blocks pure runtime-error provenance and merges exact active duplicates', (t) => {
  const f = fixture(t);
  // Create a Run that ended in pure runtime failure with no receipt
  const { task, run } = f.runningRun();
  f.force(`UPDATE run SET state = 'ended', exit_kind = 'timeout', receipt_json = NULL, ended_at = ? WHERE id = ?`, new Date().toISOString(), run.id);

  assert.throws(
    () => f.ledger.propose({
      outputs: [{ title: '超时报错自动学到的规则', body: '刚才超时失败了，下次换个机器试试看。', project_ids: [f.projectId] }],
      why: WHY,
      evidence: [{ source: 'run', ref: run.id, location: 'run', excerpt: 'timeout error' }],
    }, { source: 'worker', by: run.id, client: `run:${run.id}`, writers: ['codex'], taskId: task.id, runId: run.id }, USER),
    /纯运行报错/,
  );

  // Duplicate merge: submitting the exact same active entry again via Router merges without duplicating cards
  const beforeCount = f.ledger.listEntries().length;
  const first = f.ledger.propose({
    outputs: [{
      title: 'ClickHouse lxcfs 内存修复规范',
      when_to_use: '部署容器集群节点时',
      body: '在所有 Slurm 计算节点启用 lxcfs 并挂载 /proc/meminfo 到容器内，防止 ClickHouse 读取宿主机总内存。',
      project_ids: [f.projectId],
    }],
    why: WHY,
    evidence: EVIDENCE,
  }, { source: 'router', by: 'router', client: 'router', writers: [], projectId: f.projectId }, USER);
  assert.equal(first.state, 'published');
  assert.equal(f.ledger.listEntries().length, beforeCount + 1);

  const second = f.ledger.propose({
    outputs: [{
      title: 'ClickHouse lxcfs 内存修复规范',
      when_to_use: '部署容器集群节点时',
      body: '在所有 Slurm 计算节点启用 lxcfs 并挂载 /proc/meminfo 到容器内，防止 ClickHouse 读取宿主机总内存。',
      project_ids: [f.projectId],
    }],
    why: WHY,
    evidence: [{ source: 'conversation', ref: 'turn-2', location: 'L2', excerpt: '二次验证通过' }],
  }, { source: 'router', by: 'router', client: 'router', writers: [], projectId: f.projectId }, USER);
  assert.equal(second.state, 'published');
  assert.equal(f.ledger.listEntries().length, beforeCount + 1, 'duplicate proposal merged cleanly without creating a second knowledge row');
  assert.ok(second.merged_into, 'returns merged_into entry id');
});

test('versioned JSONL knowledge export and import supports dry-run preview and idempotent deduplication', (t) => {
  const f1 = fixture(t);
  ownerEntry(f1, {
    title: '全局架构红线',
    when_to_use: '所有工程改动',
    body: '禁止绕过账本事务直接写磁盘状态。',
    project_ids: null,
    search_phrases: ['账本事务红线'],
  });
  ownerEntry(f1, {
    title: '项目专属部署步骤',
    when_to_use: '上线前',
    body: '先跑 npm run typecheck 和 check:i18n，再打包升级。',
    project_ids: [f1.projectId],
  });

  const jsonl = f1.ledger.exportKnowledgeJsonl();
  assert.match(jsonl, /"format":"tycho-knowledge-jsonl"/);
  assert.match(jsonl, /"search_phrases":\["账本事务红线"\]/);

  const f2 = fixture(t);
  const dry = f2.ledger.importKnowledgeJsonl(jsonl, { dryRun: true, targetProjectIds: [f2.projectId], ctx: OWNER });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.created, 2);
  assert.equal(dry.invalid, 0);
  assert.equal(f2.ledger.listEntries().length, 0, 'dry-run writes nothing');

  const applied = f2.ledger.importKnowledgeJsonl(jsonl, { dryRun: false, targetProjectIds: [f2.projectId], ctx: OWNER });
  assert.equal(applied.created, 2);
  assert.equal(f2.ledger.listEntries().length, 2);
  // Search phrase survived JSONL round-trip
  assert.equal(f2.ledger.searchLibrary({ query: '账本事务红线', scope: { projectId: f2.projectId } }).total, 1);

  // Re-importing the exact same JSONL skips duplicates cleanly
  const again = f2.ledger.importKnowledgeJsonl(jsonl, { dryRun: false, targetProjectIds: [f2.projectId], ctx: OWNER });
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 2);
});
