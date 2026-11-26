// Frozen 765 v1 writer (original module; import roots adjusted for the fixture).
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { lockFile } from '../../../service/config.ts';
import { Db, SCHEMA_VERSION, nowIso } from '../../../service/db.ts';
import { InputError } from '../../../service/errors.ts';
import { ulid } from '../../../service/ids.ts';
import { parseLanding } from '../../../service/land.ts';
import { acquireLock } from '../../../service/lock.ts';
import { parseReviewOf } from '../../../service/review.ts';
import { openProjectHome, PROJECT_HOME_KEY_PREFIX, type ProjectHandoff, type ProjectHome, type ProjectHomeIdentity, type ProjectOwnership } from '../../../service/project-home.ts';
import { projectOutboxScopes } from '../../../service/project-home-guard.ts';

const FORMAT = 'tycho-project-handoff-v1';
const LIMIT = 64 * 1024 * 1024;
const PROJECT = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const INSTALL_KEY = (id: string) => 'handoff-installed:' + id;
const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

type Row = Record<string, string | number | null>;
const byProject = 'project_id = ?1';
const taskIds = `SELECT id FROM task WHERE ${byProject}`;
const runIds = `SELECT id FROM run WHERE task_id IN (${taskIds})`;
const contextIds = `SELECT id FROM router_context WHERE ${byProject}`;
const messageIds = `SELECT id FROM message WHERE ${byProject} OR task_id IN (${taskIds})`;
const ruleIds = `SELECT id FROM trigger_rule WHERE ${byProject}`;
const calls = `SELECT id FROM router_call WHERE ${byProject}`;
const roleIds = `SELECT DISTINCT role_id FROM task WHERE ${byProject} AND role_id IS NOT NULL`;
const contextAuditActions = new Set(['router.material', 'router.session_ref']);
const contextAuditSql = [...contextAuditActions].map((action) => `'${action}'`).join(', ');
const audit = `projectScope.id IS NOT NULL OR task_id IN (${taskIds}) OR run_id IN (${runIds})
  OR message_id IN (${messageIds}) OR tool_call_id IN (${calls})
  OR (change.action IN (${contextAuditSql}) AND json_extract(change.detail_json, '$.router_context_id') IN (${contextIds}))`;
const auditProject = "LEFT JOIN project AS projectScope ON projectScope.id = ?1 AND json_extract(change.detail_json, '$.project_id') = projectScope.id";

// The transaction defers foreign keys for the existing segment/message and causal
// graph. The current database schema supplies the column shapes for this one version.
const queries = {
  project: 'WHERE id = ?1',
  task: `WHERE ${byProject}`,
  run: `WHERE id IN (${runIds})`,
  router_segment: `WHERE ${byProject}`,
  router_context: `WHERE id IN (${contextIds})`,
  message: `WHERE id IN (${messageIds})`,
  input: `WHERE task_id IN (${taskIds})`,
  approval: `WHERE task_id IN (${taskIds})`,
  trigger_rule: `WHERE ${byProject}`,
  trigger_fire: `WHERE ${byProject}`,
  trigger_cursor: `WHERE trigger_id IN (${ruleIds})`,
  router_call: `WHERE ${byProject}`,
  router_exchange: `WHERE message_id IN (${messageIds})`,
  router_template: `WHERE hash IN (SELECT template_hash FROM router_exchange WHERE message_id IN (${messageIds}))`,
  push: `WHERE ${byProject}`,
  usage: `WHERE run_id IN (${runIds}) OR context_id IN (${contextIds})`,
  change: `${auditProject} WHERE ${audit}`,
} as const;
type Table = keyof typeof queries;
const tables = Object.keys(queries) as Table[];
const directProjectTables = ['task', 'router_segment', 'router_context', 'trigger_rule', 'trigger_fire', 'router_call', 'push'] satisfies Table[];

interface Bundle {
  format: typeof FORMAT;
  schema: number;
  project_id: string;
  source: ProjectHomeIdentity;
  generation: number;
  roles: Row[];
  rows: Record<Table, Row[]>;
}

function offline<T>(dataDir: string, action: (db: Db, home: ProjectHome) => T): T {
  const path = join(dataDir, 'ledger.db');
  if (!existsSync(path)) throw new InputError('找不到 Tycho 账本，先初始化目标服务');
  const lock = lockFile(dataDir);
  acquireLock(lock, (line) => console.error(line));
  try {
    const home = openProjectHome(dataDir);
    try {
      const db = new Db(path, false, {}, { projectHome: home });
      try {
        return action(db, home);
      } finally {
        db.close();
      }
    } finally {
      home.close();
    }
  } finally {
    rmSync(lock, { force: true });
  }
}

function readInstalled(db: Db, project: string): ProjectOwnership | undefined {
  const row = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', PROJECT_HOME_KEY_PREFIX + project);
  return row === undefined ? undefined : JSON.parse(row.value_json) as ProjectOwnership;
}

function requirePortable(db: Db, projectId: string): void {
  const project = db.get<Row>('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new InputError('项目不存在');
  if (project.paused_at === null || project.archived_at !== null) throw new InputError('请先暂停项目，移交后在目标服务恢复');
  if (project.router_account !== null || project.login_mode !== 'all' || project.logins_json !== '[]' || project.machines_json !== '[]' || project.spawn_machines !== 0) {
    throw new InputError('项目还依赖本服务的总控、执行登录或机器配置，请解除这些绑定后再移交');
  }
  const rules: [string, string][] = [
    ['运行或待核实的轮次', `SELECT 1 FROM run WHERE id IN (${runIds}) AND state != 'ended'`],
    ['运行中的总控', `SELECT 1 FROM router_context WHERE id IN (${contextIds}) AND (live_at IS NOT NULL OR pid IS NOT NULL)`],
    ['未结算的总控工具', `SELECT 1 FROM router_call WHERE project_id = ?1 AND finished_at IS NULL`],
    ['未结算的总控回合', `SELECT 1 FROM router_exchange WHERE message_id IN (${messageIds}) AND finished_at IS NULL`],
    ['正在处理或待核实的消息', `SELECT 1 FROM message WHERE id IN (${messageIds}) AND state IN ('processing', 'unverified')`],
    ['还在等待发送的成果或提醒', "SELECT 1 FROM push WHERE project_id = ?1 AND state = 'open'"],
    ['还在发送、失败待核实的通知', `SELECT 1 FROM outbox queued WHERE state != 'sent' AND ?1 IN (${projectOutboxScopes('queued').join(' UNION ')})`],
    ['派生节点接入记录', 'SELECT 1 FROM machine_invite WHERE project_id = ?1'],
    ['任务引用了源服务已删除的职能', `SELECT 1 FROM (${roleIds}) requested WHERE NOT EXISTS(SELECT 1 FROM role WHERE role.id = requested.role_id)`],
    ['本机代码目录', "SELECT 1 FROM project, json_each(sources_json) item WHERE project.id = ?1 AND json_extract(item.value, '$.kind') != 'repo'"],
    ['工作绑定了本机代码目录、登录或技能', `SELECT 1 FROM task WHERE id IN (${taskIds}) AND
      (login_id IS NOT NULL OR prefer_json IS NOT NULL OR skills_json IS NOT NULL OR json_extract(source_json, '$.pinned.kind') = 'folder')`],
    ['需单独迁移的文件证据或技能知识', `SELECT 1 FROM run WHERE id IN (${runIds}) AND
      ((artifacts_json IS NOT NULL AND releases_dropped_at IS NULL)
       OR COALESCE(json_array_length(snapshot_json, '$.knowledge'), 0) > 0
       OR COALESCE(json_array_length(snapshot_json, '$.skills'), 0) > 0
       OR EXISTS(SELECT 1 FROM json_each(receipt_json, '$.artifacts') receipt WHERE json_extract(receipt.value, '$.kind') = 'file'))`],
    ['项目范围知识', 'SELECT 1 FROM knowledge_revision, json_each(projects_json) scope WHERE scope.value = ?1'],
    ['跨范围知识提议或证据', `SELECT 1 FROM knowledge_proposal proposal WHERE task_id IN (${taskIds}) OR run_id IN (${runIds})
       OR EXISTS (SELECT 1 FROM json_each(proposal.change_json, '$.outputs') output, json_each(output.value, '$.project_ids') scope WHERE scope.value = ?1)
       OR EXISTS (SELECT 1 FROM knowledge_evidence evidence WHERE proposal.id = evidence.proposal_id AND
         ((evidence.source = 'task' AND evidence.ref IN (${taskIds})) OR (evidence.source = 'run' AND evidence.ref IN (${runIds}))))`],
    ['外部入站授权或历史，需在环境间另行核对', `SELECT 1 FROM inbound_source, json_each(projects_json) project WHERE project.value = ?1
       UNION SELECT 1 FROM trigger_fire WHERE project_id = ?1 AND source_id IS NOT NULL`],
  ];
  for (const [reason, query] of rules) {
    if (db.get(query, projectId) !== undefined) throw new InputError('项目目前无法移交：' + reason);
  }
}

function exportBundle(db: Db, home: ProjectHome, projectId: string, installed: ProjectOwnership): Buffer {
  requirePortable(db, projectId);
  const rows = Object.fromEntries(tables.map((table) => [table, db.all<Row>(`SELECT "${table}".* FROM "${table}" ${queries[table]} ORDER BY "${table}".rowid`, projectId)]));
  const bytes = Buffer.from(JSON.stringify({
    format: FORMAT, schema: SCHEMA_VERSION, project_id: projectId, source: home.identity,
    generation: installed.generation + 1,
    roles: db.all<Row>(`SELECT id, name, description, default_tier, permission, deliverable, needs_review FROM role WHERE id IN (${roleIds}) ORDER BY id`, projectId),
    rows,
  }), 'utf8');
  if (bytes.length > LIMIT) throw new InputError('项目移交包超过 64 MiB');
  return bytes;
}

function parseBundle(bytes: Buffer): Bundle {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new InputError('项目移交包大小无效');
  let bundle: Bundle;
  try {
    bundle = JSON.parse(bytes.toString('utf8')) as Bundle;
  } catch {
    throw new InputError('项目移交包不是有效 JSON');
  }
  if (bundle?.format !== FORMAT || bundle.schema !== SCHEMA_VERSION || typeof bundle.project_id !== 'string' || !PROJECT.test(bundle.project_id)
    || !Number.isSafeInteger(bundle.generation) || bundle.generation < 2 || !bundle.source || typeof bundle.source.id !== 'string'
    || !Array.isArray(bundle.roles) || !bundle.rows || Object.keys(bundle.rows).length !== tables.length || !tables.every((table) => Array.isArray(bundle.rows[table]))
    || bundle.rows.project.length !== 1 || bundle.rows.project[0]?.id !== bundle.project_id || typeof bundle.rows.project[0]?.paused_at !== 'string') {
    throw new InputError('项目移交包的版本、项目或表结构无效');
  }
  return bundle;
}

function requireTargetReady(db: Db, bundle: Bundle): void {
  if (db.get('SELECT 1 FROM project WHERE id = ? OR name = ? COLLATE NOCASE', bundle.project_id, bundle.rows.project[0]!.name)) {
    throw new InputError('目标已有同编号或同名项目，请处理冲突后再准备移交');
  }
  for (const role of bundle.roles) {
    const local = db.get<Row>('SELECT id, name, description, default_tier, permission, deliverable, needs_review FROM role WHERE id = ?', role?.id);
    if (!local || Object.keys(local).length !== Object.keys(role).length || Object.keys(local).some((field) => local[field] !== role[field])) {
      throw new InputError('目标服务需配置相同的任务职能后才能接管：' + String(role?.id ?? '∅'));
    }
  }
}

function validateBundleScope(db: Db, bundle: Bundle): void {
  const { project_id: projectId, rows } = bundle;
  const ids = Object.fromEntries(tables.map((table) => [table, new Set(rows[table].map((row) => row?.id))]));
  const contained = (table: string, field: string, value: unknown, target: string): void => {
    if (value !== null && !ids[target]?.has(value as string)) throw new InputError(`项目移交包引用了包外的账本对象（${table}.${field}）`);
  };
  for (const table of directProjectTables) {
    if (rows[table].some((row) => row?.project_id !== projectId)) throw new InputError('项目移交包的账本记录缺少本项目归属：' + table);
  }
  for (const table of tables) {
    const refs = db.all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${table}")`);
    for (const row of rows[table]) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new InputError('项目移交包的数据无效：' + table);
      if (row.project_id != null && row.project_id !== projectId) throw new InputError('项目移交包包含其他项目的账本记录');
      for (const ref of refs) {
        if (ref.table === 'router_template') continue;
        contained(table, ref.from, row[ref.from], ref.table);
      }
    }
  }
  const templates = new Set(rows.router_exchange.map(({ template_hash }) => template_hash));
  for (const { hash, text } of rows.router_template) {
    if (typeof text !== 'string' || !templates.delete(hash) || digestOf(Buffer.from(text)) !== hash) throw new InputError('项目移交包的总控模板摘要无效');
  }
  if (templates.size !== 0) throw new InputError('项目移交包缺少总控模板');
  for (const row of rows.message) {
    if (row.project_id === null && row.task_id === null) throw new InputError('项目移交包的消息缺少项目归属');
  }
  for (const row of rows.usage) {
    if (row.run_id === null && row.context_id === null) throw new InputError('项目移交包的用量记录缺少项目归属');
  }
  for (const row of rows.change) {
    const detail = row.detail_json === null ? null : JSON.parse(String(row.detail_json));
    if (detail?.project_id != null && detail.project_id !== projectId) throw new InputError('项目移交包的审计记录引用其他项目');
    if (detail?.turn_message_id !== undefined) contained('change', 'turn_message_id', detail.turn_message_id, 'message');
    const contextAudit = contextAuditActions.has(String(row.action));
    const routerContext = contextAudit ? detail?.router_context_id : undefined;
    if (contextAudit) {
      if (typeof routerContext !== 'string') throw new InputError('项目移交包的总控审计缺少上下文');
      contained('change', 'router_context_id', routerContext, 'router_context');
    }
    if (row.task_id === null && row.run_id === null && row.message_id === null && row.tool_call_id === null && detail?.project_id !== projectId && routerContext === undefined) {
      throw new InputError('项目移交包的审计记录缺少项目归属');
    }
  }
  for (const { review_task_id } of rows.approval) contained('approval', 'review_task_id', review_task_id, 'task');
  for (const row of rows.task) {
    contained('task', 'trigger_fire_id', row.trigger_fire_id, 'trigger_fire');
    if (typeof row.review_of_json === 'string') {
      const binding = parseReviewOf(row.review_of_json);
      if (!binding) throw new InputError('项目移交包包含无效的审阅绑定');
      contained('task', 'review_of_json', binding.task_id, 'task');
      contained('task', 'review_of_json', binding.run_id, 'run');
    }
    if (typeof row.landing_json === 'string') {
      const binding = parseLanding(row.landing_json);
      if (!binding) throw new InputError('项目移交包包含无效的合入绑定');
      contained('task', 'landing_json', binding.of, 'task');
    }
  }
  for (const { message_ids_json } of rows.router_call) {
    const messages: unknown = JSON.parse(String(message_ids_json));
    if (!Array.isArray(messages)) throw new InputError('项目移交包的调用消息无效');
    for (const message of messages) contained('router_call', 'message_ids_json', message, 'message');
  }
}

function insertBundle(db: Db, bundle: Bundle, ownership: ProjectOwnership, transfer: ProjectHandoff): string {
  const { project_id: projectId, rows } = bundle;
  return db.transaction(() => {
    const prior = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', INSTALL_KEY(projectId));
    const marker = JSON.stringify({ transfer_id: transfer.transfer_id, bundle_sha256: transfer.bundle_sha256 });
    if (prior?.value_json === marker && readInstalled(db, projectId)?.generation === ownership.generation) return transfer.bundle_sha256;
    if (prior) throw new InputError('目标已经存在另一份项目安装记录');
    requireTargetReady(db, bundle);
    validateBundleScope(db, bundle);
    db.get('PRAGMA defer_foreign_keys = ON');
    db.installProjectOwnership(projectId, ownership);
    for (const table of tables) {
      const columns = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map(({ name }) => name);
      const installColumns = columns.filter((name) => table !== 'change' || name !== 'seq');
      for (const row of rows[table]) {
        if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== columns.length
          || !columns.every((column) => Object.hasOwn(row, column)
            && (row[column] === null || typeof row[column] === 'number' || typeof row[column] === 'string'))) {
          throw new InputError('项目移交包的数据与账本列不一致：' + table);
        }
        if (table === 'router_template') {
          const shared = db.get<{ text: string }>('SELECT text FROM router_template WHERE hash = ?', row.hash);
          if (shared !== undefined) {
            if (shared.text !== row.text) throw new InputError('目标已保存内容不一致的总控模板');
            continue;
          }
        }
        db.run(`INSERT INTO "${table}" (${installColumns.map((name) => '"' + name + '"').join(', ')}) VALUES (${installColumns.map(() => '?').join(', ')})`,
          ...installColumns.map((name) => {
            // An orderly service stop keeps a reusable but inactive local context.
            // Preserve its history while forcing the receiving service to start clean.
            if (table === 'router_context' && row.state === 'open') {
              if (name === 'state') return 'closed';
              if (name === 'closed_at') return nowIso();
              if (name === 'closed_reason') return '项目归属已移交';
            }
            return row[name] as SQLInputValue;
          }),
        );
      }
    }
    db.run('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)', ulid(), nowIso(), INSTALL_KEY(projectId), marker);
    return transfer.bundle_sha256;
  });
}

export function exportProjectHandoff(dataDir: string, projectId: string): Buffer {
  if (!PROJECT.test(projectId)) throw new InputError('项目编号无效');
  return offline(dataDir, (db, home) => {
    const installed = readInstalled(db, projectId);
    home.assertWritable(projectId, installed);
    return exportBundle(db, home, projectId, installed!);
  });
}

export function stageProjectHandoff(dataDir: string, bytes: Buffer, trustedSource: ProjectHomeIdentity, replace = false): ProjectHomeIdentity {
  const bundle = parseBundle(bytes);
  if (bundle.source.id !== trustedSource.id || bundle.source.public_key !== trustedSource.public_key) throw new InputError('移交包与已核实的源服务身份不一致');
  return offline(dataDir, (db, home) => {
    requireTargetReady(db, bundle);
    validateBundleScope(db, bundle);
    home.stageIncoming({ project_id: bundle.project_id, source: trustedSource, generation: bundle.generation, bundle_sha256: digestOf(bytes) }, replace);
    return home.identity;
  });
}

export function freezeProjectHandoff(dataDir: string, bytes: Buffer, targetServiceId: string): ProjectHandoff {
  const bundle = parseBundle(bytes);
  return offline(dataDir, (db, home) => {
    if (bundle.source.id !== home.identity.id || bundle.source.public_key !== home.identity.public_key) throw new InputError('这份移交包来自另一服务');
    const installed = readInstalled(db, bundle.project_id);
    if (installed === undefined || bundle.generation !== installed.generation + 1) throw new InputError('项目移交包的数据代次未核实');
    return home.freezeForTransfer({ project_id: bundle.project_id, target: targetServiceId, bundle_sha256: digestOf(bytes) }, installed,
      () => digestOf(exportBundle(db, home, bundle.project_id, installed)));
  });
}

export function importProjectHandoff(
  dataDir: string, bytes: Buffer, receipt: ProjectHandoff,
  testHooks: { afterLedgerInstall?: () => void } = {},
): ProjectOwnership {
  const bundle = parseBundle(bytes);
  const digest = digestOf(bytes);
  if (receipt.bundle_sha256 !== digest || receipt.project_id !== bundle.project_id || receipt.source_service !== bundle.source.id || receipt.generation !== bundle.generation) {
    throw new InputError('移交凭证与待接管的数据不一致');
  }
  return offline(dataDir, (db, home) => {
    const ownership = home.acceptIncoming(receipt, (claim, handoff) => {
      const installed = insertBundle(db, bundle, claim, handoff);
      testHooks.afterLedgerInstall?.();
      return installed;
    });
    const marker = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', INSTALL_KEY(bundle.project_id));
    const installed = readInstalled(db, bundle.project_id);
    if (!db.get('SELECT 1 FROM project WHERE id = ?', bundle.project_id)
      || installed?.service_id !== ownership.service_id || installed.generation !== ownership.generation
      || marker?.value_json !== JSON.stringify({ transfer_id: receipt.transfer_id, bundle_sha256: digest })) {
      throw new InputError('目标账本缺少接管记录，请恢复接管后的目标账本再核实');
    }
    return ownership;
  });
}
