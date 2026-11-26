import { collectPortableKnowledge, validatePortableKnowledge, requireKnowledgeHandoffTargetReady, KNOWLEDGE_TABLES } from './project-handoff-knowledge.ts';
import { collectHandoffFiles, parseHandoffFiles, handoffFileWire, prepareHandoffFiles, verifyHandoffFiles, type HandoffFile } from './project-handoff-files.ts';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { lockFile } from './config.ts';
import { Db, SCHEMA_VERSION, nowIso } from './db.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import { parseLanding } from './land.ts';
import { acquireLock } from './lock.ts';
import { parseReviewOf } from './review.ts';
import { openProjectHome, PROJECT_HOME_KEY_PREFIX, type ProjectHandoff, type ProjectHome, type ProjectHomeIdentity, type ProjectOwnership } from './project-home.ts';
import { projectOutboxScopes } from './project-home-guard.ts';

const FORMAT = 'tycho-project-handoff-v2';
const LEGACY_FORMAT = 'tycho-project-handoff-v1';
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
type CoreTable = keyof typeof queries;
type Table = CoreTable | typeof KNOWLEDGE_TABLES[number];
const coreTables = Object.keys(queries) as CoreTable[];
const tables: Table[] = [...coreTables, ...KNOWLEDGE_TABLES];
const directProjectTables = ['task', 'router_segment', 'router_context', 'trigger_rule', 'trigger_fire', 'router_call', 'push'] satisfies Table[];

interface Bundle {
  format: typeof FORMAT | typeof LEGACY_FORMAT;
  files: HandoffFile[];
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

function requirePortable(db: Db, projectId: string, materials = false): void {
  const project = db.get<Row>('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new InputError('项目不存在');
  if (project.paused_at === null || project.archived_at !== null) throw new InputError('请先暂停项目，移交后在目标服务恢复');
  if (project.router_account !== null || project.login_mode !== 'all' || project.logins_json !== '[]' || project.machines_json !== '[]' || project.spawn_machines !== 0) {
    throw new InputError('项目还依赖本服务的负责人、执行登录或机器配置，请解除这些绑定后再移交');
  }
  const rules: [string, string, boolean?][] = [
    ['运行或待核实的轮次', `SELECT 1 FROM run WHERE id IN (${runIds}) AND state != 'ended'`],
    ['运行中的负责人', `SELECT 1 FROM router_context WHERE id IN (${contextIds}) AND (live_at IS NOT NULL OR pid IS NOT NULL)`],
    ['未结算的负责人工具', `SELECT 1 FROM router_call WHERE project_id = ?1 AND finished_at IS NULL`],
    ['未结算的负责人回合', `SELECT 1 FROM router_exchange WHERE message_id IN (${messageIds}) AND finished_at IS NULL`],
    ['正在处理或待核实的消息', `SELECT 1 FROM message WHERE id IN (${messageIds}) AND state IN ('processing', 'unverified')`],
    ['还在等待发送的成果或提醒', "SELECT 1 FROM push WHERE project_id = ?1 AND state = 'open'"],
    ['还在发送、失败待核实的通知', `SELECT 1 FROM outbox queued WHERE state != 'sent' AND ?1 IN (${projectOutboxScopes('queued').join(' UNION ')})`],
    ['派生节点接入记录', 'SELECT 1 FROM machine_invite WHERE project_id = ?1'],
    ['任务引用了源服务已删除的职能', `SELECT 1 FROM (${roleIds}) requested WHERE NOT EXISTS(SELECT 1 FROM role WHERE role.id = requested.role_id)`],
    ['本机代码目录', "SELECT 1 FROM project, json_each(sources_json) item WHERE project.id = ?1 AND json_extract(item.value, '$.kind') != 'repo'"],
    ['工作绑定了本机代码目录、登录或技能', `SELECT 1 FROM task WHERE id IN (${taskIds}) AND
      (login_id IS NOT NULL OR machine_id IS NOT NULL OR prefer_json IS NOT NULL OR skills_json IS NOT NULL OR json_extract(source_json, '$.pinned.kind') = 'folder')`],
    ['需单独迁移的文件证据或技能知识', `SELECT 1 FROM run WHERE id IN (${runIds}) AND
      ((artifacts_json IS NOT NULL AND releases_dropped_at IS NULL)
       OR COALESCE(json_array_length(snapshot_json, '$.knowledge'), 0) > 0
       OR COALESCE(json_array_length(snapshot_json, '$.skills'), 0) > 0
       OR EXISTS(SELECT 1 FROM json_each(receipt_json, '$.artifacts') receipt WHERE json_extract(receipt.value, '$.kind') = 'file'))`, true],
    ['项目范围知识', 'SELECT 1 FROM knowledge_revision, json_each(projects_json) scope WHERE scope.value = ?1', true],
    ['跨范围知识提议或证据', `SELECT 1 FROM knowledge_proposal proposal WHERE task_id IN (${taskIds}) OR run_id IN (${runIds})
       OR EXISTS (SELECT 1 FROM json_each(proposal.change_json, '$.outputs') output, json_each(output.value, '$.project_ids') scope WHERE scope.value = ?1)
       OR EXISTS (SELECT 1 FROM knowledge_evidence evidence WHERE proposal.id = evidence.proposal_id AND
         ((evidence.source = 'task' AND evidence.ref IN (${taskIds})) OR (evidence.source = 'run' AND evidence.ref IN (${runIds}))))`, true],
    ['外部入站授权或历史，需在环境间另行核对', `SELECT 1 FROM inbound_source, json_each(projects_json) project WHERE project.value = ?1
       UNION SELECT 1 FROM trigger_fire WHERE project_id = ?1 AND source_id IS NOT NULL`],
    ['项目文件与交互产物', 'SELECT 1 FROM project_file WHERE project_id = ?1'],
  ];
  for (const [reason, query, legacyOnly] of rules) {
    if (materials && legacyOnly) continue;
    if (db.get(query, projectId) !== undefined) throw new InputError('项目目前无法移交：' + reason);
  }
}

function exportBundle(db: Db, home: ProjectHome, projectId: string, installed: ProjectOwnership, dataDir: string, format: Bundle['format'] = FORMAT): Buffer {
  requirePortable(db, projectId, format === FORMAT);
  const rows = Object.fromEntries(coreTables.map((table) => [table, db.all<Row>(`SELECT "${table}".* FROM "${table}" ${queries[table]} ORDER BY "${table}".rowid`, projectId)]));
  let files: HandoffFile[] = [];
  if(format === FORMAT){
    const closure = collectPortableKnowledge(db,projectId,rows.task!,rows.run!,rows.message!);
    const knowledge = closure.rows; Object.assign(rows,knowledge);
    const append = (table: CoreTable, found: Row[]): void => { const ids = new Set(rows[table]!.map(row => row.id)); for (const row of found) if (!ids.has(row.id)) { rows[table]!.push(row); ids.add(row.id); } };
    for (const gate of closure.gateIds) {
      append('task', db.all<Row>('SELECT * FROM task WHERE id = ?', gate));
      append('run', db.all<Row>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid', gate));
      for (const table of ['input', 'approval', 'message'] as const) append(table, db.all<Row>(`SELECT * FROM "${table}" WHERE task_id = ? ORDER BY rowid`, gate));
      append('usage', db.all<Row>('SELECT * FROM usage WHERE run_id IN (SELECT id FROM run WHERE task_id = ?) ORDER BY rowid', gate));
      const pendingEffect = db.get(`WITH items AS (
        SELECT payload_json AS value FROM outbox WHERE state != 'sent'
        UNION ALL SELECT item.value FROM outbox queued, json_each(queued.payload_json, '$.items') item WHERE queued.state != 'sent'
      ) SELECT 1 FROM items WHERE
        COALESCE(json_extract(value, '$.task_id'), json_extract(value, '$.payload.task_id')) = ?1
        OR COALESCE(json_extract(value, '$.run_id'), json_extract(value, '$.payload.run_id')) IN (SELECT id FROM run WHERE task_id = ?1)
        OR COALESCE(json_extract(value, '$.approval_id'), json_extract(value, '$.payload.approval_id')) IN (SELECT id FROM approval WHERE task_id = ?1)`, gate);
      if (pendingEffect) throw new InputError('把关任务仍有待发送通知：' + gate);

      append('change', db.all<Row>('SELECT * FROM change WHERE task_id = ? OR run_id IN (SELECT id FROM run WHERE task_id = ?) OR message_id IN (SELECT id FROM message WHERE task_id = ?) ORDER BY seq', gate, gate, gate));
    }
    const proposals=new Set(knowledge.knowledge_proposal.map(r=>r.id)),entries=new Set(knowledge.knowledge.map(r=>r.id));
    const prior=new Set(rows.change!.map(r=>r.id));
    for(const row of db.all<Row>("SELECT * FROM change WHERE action LIKE 'knowledge.%' ORDER BY rowid")){const detail=JSON.parse(String(row.detail_json));if((proposals.has(detail.proposal_id)||entries.has(detail.knowledge_id))&&!prior.has(row.id))rows.change!.push(row);}
    rows.change!.sort((a,b)=>Number(a.seq)-Number(b.seq));files=collectHandoffFiles(dataDir,rows.run!,rows.change!);
  }
  for(const row of rows.run??[]) row.capture_result_json=null;
  // Output disposal and rehost release audits belong to the source service, never to the recipient.
  rows.change=(rows.change??[]).filter(row=>row.action!=='run.capture_release');
  const wireRows=Object.fromEntries(Object.entries(rows).filter(([name])=>format===FORMAT||!KNOWLEDGE_TABLES.includes(name as any)));
  const bytes = Buffer.from(JSON.stringify({
    format, schema: SCHEMA_VERSION, project_id: projectId, source: home.identity,
    generation: installed.generation + 1,
    roles: rows.task!.flatMap(row => row.role_id === null ? [] : [String(row.role_id)]).filter((id, index, all) => all.indexOf(id) === index).sort().map(id => {
      const role = db.get<Row>('SELECT id, name, description, default_tier, permission, deliverable, needs_review FROM role WHERE id = ?', id);
      if (!role) throw new InputError('任务引用了源服务已删除的职能：' + id);
      return role;
    }),
    rows: wireRows, ...(format===FORMAT?{files: handoffFileWire(files)}:{}),
  }), 'utf8');
  if (bytes.length > LIMIT) throw new InputError('项目移交包超过 64 MiB');
  parseBundle(db, bytes);
  return bytes;
}

// This is the sole wire boundary. Downstream code receives exact ledger rows and decoded bytes.
function parseBundle(db: Db, bytes: Buffer): Bundle {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new InputError('项目移交包大小无效');
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (!object(raw) || (raw.format !== FORMAT && raw.format !== LEGACY_FORMAT)) throw new InputError('项目移交包版本无效');
    const keys = ['format', 'schema', 'project_id', 'source', 'generation', 'roles', 'rows', ...(raw.format === FORMAT ? ['files'] : [])];
    if (!exact(raw, keys) || raw.schema !== SCHEMA_VERSION || typeof raw.project_id !== 'string' || !PROJECT.test(raw.project_id)
      || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 2 || !exact(raw.source, ['id', 'public_key'])
      || typeof raw.source.id !== 'string' || typeof raw.source.public_key !== 'string' || !Array.isArray(raw.roles)) throw new InputError('项目移交包的身份或结构无效');
    const included: readonly Table[] = raw.format === FORMAT ? tables : coreTables;
    if (!exact(raw.rows, included)) throw new InputError('项目移交包的表集合无效');
    const rows = {} as Record<Table, Row[]>;
    for (const table of tables) {
      if (!included.includes(table)) { rows[table] = []; continue; }
      const supplied = raw.rows[table];
      if (!Array.isArray(supplied)) throw new InputError('项目移交包的表不是列表：' + table);
      const columns = db.all<{ name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info("${table}")`);
      const primary = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk);
      const seen = new Set<string>(), identifiers = new Set<string>();
      rows[table] = supplied.map(value => {
        if (!exact(value, columns.map(column => column.name))) throw new InputError('项目移交包的数据与账本列不一致：' + table);
        for (const column of columns) {
          const cell = value[column.name];
          if (cell === null) { if (column.notnull || column.pk) throw new InputError('项目移交包缺少必填列：' + table + '.' + column.name); }
          else if (column.type === 'INTEGER' ? !Number.isSafeInteger(cell) : column.type === 'REAL' ? typeof cell !== 'number' || !Number.isFinite(cell) : typeof cell !== 'string') throw new InputError('项目移交包的列类型无效：' + table + '.' + column.name);
          if (cell !== null && column.name.endsWith('_json')) JSON.parse(String(cell));
        }
        const key = JSON.stringify(primary.map(column => value[column.name]));
        if (seen.has(key) || typeof value.id === 'string' && identifiers.has(value.id)) throw new InputError('项目移交包包含重复记录：' + table);
        seen.add(key);
        if (typeof value.id === 'string') identifiers.add(value.id);
        return value as Row;
      });
    }
    const roleKeys = ['id', 'name', 'description', 'default_tier', 'permission', 'deliverable', 'needs_review'];
    const roles: Row[] = [];
    for (const value of raw.roles) {
      if (!exact(value, roleKeys) || roleKeys.some(key => key === 'needs_review' ? value[key] !== 0 && value[key] !== 1 : typeof value[key] !== 'string') || roles.some(role => role.id === value.id)) throw new InputError('项目移交包的职能无效');
      roles.push(value as Row);
    }
    if (rows.project.length !== 1 || rows.project[0]!.id !== raw.project_id || typeof rows.project[0]!.paused_at !== 'string' || rows.project[0]!.archived_at !== null) throw new InputError('项目移交包缺少暂停中的项目');
    const files = parseHandoffFiles(raw.format === FORMAT ? raw.files : [], rows.run, rows.change);
    const bundle: Bundle = { format: raw.format, schema: raw.schema as number, project_id: raw.project_id, source: raw.source as unknown as ProjectHomeIdentity, generation: raw.generation as number, roles, rows, files };
    const gates = validatePortableKnowledge(rows, bundle.project_id, rows.task, rows.run, rows.message, rows.change, rows.router_call);
    validateBundleScope(db, bundle, gates);
    return bundle;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('项目移交包包含无效 JSON 或引用结构');
  }
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
  for (const table of tables) {
    if (table === 'project' || table === 'router_template') continue;
    const primary = table === 'change' ? ['id'] : db.all<{ name: string; pk: number }>(`PRAGMA table_info("${table}")`).filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    for (const row of bundle.rows[table]) {
      if (db.get(`SELECT 1 FROM "${table}" WHERE ${primary.map(key => '"' + key + '" = ?').join(' AND ')}`, ...primary.map(key => row[key]))) {
        throw new InputError('目标存在同编号的账本记录：' + table + ' / ' + primary.map(key => String(row[key])).join('@'));
      }
    }
  }
  requireKnowledgeHandoffTargetReady(db, bundle.rows);
}

function validateBundleScope(db: Db, bundle: Bundle, gates: ReadonlySet<string>): void {
  const { project_id: projectId, rows } = bundle;
  const project = rows.project[0]!;
  if (project.router_account !== null || project.login_mode !== 'all' || project.logins_json !== '[]' || project.machines_json !== '[]' || project.spawn_machines !== 0) throw new InputError('项目移交包依赖源服务的登录或机器绑定');
  if(rows.run.some(row=>row.capture_result_json!==null)||rows.change.some(row=>row.action==='run.capture_release'))throw new InputError('项目移交包不能携带源节点输出释放权');
  if (rows.run.some(row => row.state !== 'ended') || rows.router_context.some(row => row.live_at !== null || row.pid !== null)
    || rows.router_call.some(row => row.finished_at === null) || rows.router_exchange.some(row => row.finished_at === null)
    || rows.message.some(row => row.state === 'processing' || row.state === 'unverified') || rows.push.some(row => row.state === 'open')) throw new InputError('项目移交包仍有在途工作');
  if (rows.task.some(row => row.login_id !== null || row.prefer_json !== null || row.skills_json !== null)) throw new InputError('任务仍绑定源服务的登录或点名技能');
  const roleIds = new Set(bundle.roles.map(role => role.id));
  if (rows.task.some(row => row.role_id !== null && !roleIds.has(row.role_id))) throw new InputError('项目移交包缺少任务职能');
  const ids = Object.fromEntries(tables.map((table) => [table, new Set(rows[table].map((row) => row?.id))]));
  const contained = (table: string, field: string, value: unknown, target: string): void => {
    if (value !== null && !ids[target]?.has(value as string)) throw new InputError(`项目移交包引用了包外的账本对象（${table}.${field}）`);
  };
  for (const table of directProjectTables) {
    if (rows[table].some((row) => row?.project_id !== projectId && !(table === 'task' && row.project_id === null && gates.has(String(row.id))))) throw new InputError('项目移交包的账本记录缺少本项目归属：' + table);
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
    if (typeof text !== 'string' || !templates.delete(hash) || digestOf(Buffer.from(text)) !== hash) throw new InputError('项目移交包的负责人模板摘要无效');
  }
  if (templates.size !== 0) throw new InputError('项目移交包缺少负责人模板');
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
      if (typeof routerContext !== 'string') throw new InputError('项目移交包的负责人审计缺少上下文');
      contained('change', 'router_context_id', routerContext, 'router_context');
    }
    if (row.task_id === null && row.run_id === null && row.message_id === null && row.tool_call_id === null && detail?.project_id !== projectId && routerContext === undefined && !(String(row.action).startsWith('knowledge.') && (ids.knowledge_proposal!.has(detail?.proposal_id) || ids.knowledge!.has(detail?.knowledge_id)))) {
      throw new InputError('项目移交包的审计记录缺少项目归属');
    }
  }
  if (rows.approval.some(row => gates.has(String(row.task_id)) && row.state === 'open')) throw new InputError('把关任务仍有开放授权');
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
    db.get('PRAGMA defer_foreign_keys = ON');
    db.installProjectOwnership(projectId, ownership);
    for (const table of tables) {
      const columns = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map(({ name }) => name);
      const installColumns = columns.filter((name) => table !== 'change' || name !== 'seq');
      for (const row of rows[table]) {
        if (table === 'router_template') {
          const shared = db.get<{ text: string }>('SELECT text FROM router_template WHERE hash = ?', row.hash);
          if (shared !== undefined) {
            if (shared.text !== row.text) throw new InputError('目标已保存内容不一致的负责人模板');
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
    return exportBundle(db, home, projectId, installed!, dataDir);
  });
}

export function stageProjectHandoff(dataDir: string, bytes: Buffer, trustedSource: ProjectHomeIdentity, replace = false): ProjectHomeIdentity {
  return offline(dataDir, (db, home) => {
    const bundle = parseBundle(db, bytes);
    if (bundle.source.id !== trustedSource.id || bundle.source.public_key !== trustedSource.public_key) throw new InputError('移交包与已核实的源服务身份不一致');
    requireTargetReady(db, bundle);
    home.stageIncoming({ project_id: bundle.project_id, source: trustedSource, generation: bundle.generation, bundle_sha256: digestOf(bytes) }, replace);
    return home.identity;
  });
}

export function freezeProjectHandoff(dataDir: string, bytes: Buffer, targetServiceId: string): ProjectHandoff {
  return offline(dataDir, (db, home) => {
    const bundle = parseBundle(db, bytes);
    if (bundle.source.id !== home.identity.id || bundle.source.public_key !== home.identity.public_key) throw new InputError('这份移交包来自另一服务');
    const installed = readInstalled(db, bundle.project_id);
    if (installed === undefined || bundle.generation !== installed.generation + 1) throw new InputError('项目移交包的数据代次未核实');
    return home.freezeForTransfer({ project_id: bundle.project_id, target: targetServiceId, bundle_sha256: digestOf(bytes) }, installed,
      () => digestOf(exportBundle(db, home, bundle.project_id, installed, dataDir, bundle.format)));
  });
}

export function importProjectHandoff(
  dataDir: string, bytes: Buffer, receipt: ProjectHandoff,
  testHooks: { afterLedgerInstall?: () => void } = {},
): ProjectOwnership {
  const digest = digestOf(bytes);
  return offline(dataDir, (db, home) => {
    const bundle = parseBundle(db, bytes);
    if (receipt.bundle_sha256 !== digest || receipt.project_id !== bundle.project_id || receipt.source_service !== bundle.source.id || receipt.generation !== bundle.generation) throw new InputError('移交凭证与待接管的数据不一致');
    const ownership = home.acceptIncoming(receipt, (claim, handoff) => {
      const prior = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', INSTALL_KEY(bundle.project_id));
      const retry = JSON.stringify({ transfer_id: handoff.transfer_id, bundle_sha256: digest });
      if (prior?.value_json !== retry) requireTargetReady(db, bundle);
      prepareHandoffFiles(dataDir, bundle.files, handoff.transfer_id, digest);
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
    verifyHandoffFiles(dataDir, bundle.files);
    return ownership;
  });
}
