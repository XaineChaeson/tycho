import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_HOME_KEY_PREFIX, type ProjectHome, type ProjectOwnership } from './project-home.ts';

// Every table is classified below. Names here follow direct foreign keys first, then the
// few persisted JSON references in agreements, audit and messages. A new table must make
// its ownership rule explicit before a guarded ledger can open.
const scopes: Record<string, (row: string) => readonly string[]> = {
  project: (r) => [`SELECT ${r}.id`],
  task: (r) => [`SELECT ${r}.project_id`, `SELECT project_id FROM task WHERE id = ${r}.parent_id`],
  run: (r) => [task(r, 'task_id')],
  message: (r) => [`SELECT ${r}.project_id`, task(r, 'task_id'), `SELECT project_id FROM router_segment WHERE id = ${r}.segment_id`],
  input: (r) => [task(r, 'task_id'), run(r, 'run_id'), message(r, 'message_id')],
  approval: (r) => [task(r, 'task_id'), run(r, 'run_id'), task(r, 'review_task_id')],
  router_segment: direct,
  router_context: direct,
  router_call: direct,
  router_exchange: (r) => [message(r, 'message_id'), `SELECT project_id FROM router_context WHERE id = ${r}.context_id`],
  push: direct,
  trigger_rule: direct,
  trigger_cursor: (r) => [`SELECT project_id FROM trigger_rule WHERE id = ${r}.trigger_id`],
  trigger_fire: direct,
  inbound_receipt_reply: (r) => [`SELECT project_id FROM trigger_fire WHERE id = ${r}.fire_id`],
  machine_invite: direct,
  machine_material: (r) => [`SELECT project_id FROM machine_invite WHERE id = ${r}.invite_id`, run(r, 'run_id')],
  machine: (r) => [`SELECT project_id FROM machine_invite WHERE id = ${r}.invite_id`],
  outbox: projectOutboxScopes,
  inbound_source: (r) => [`SELECT value FROM json_each(${r}.projects_json)`, `SELECT ${r}.streak_project_id`],
  inbound_key: (r) => [`SELECT allowed.value FROM inbound_source, json_each(inbound_source.projects_json) AS allowed WHERE inbound_source.id = ${r}.source_id`],
  knowledge: (r) => [`SELECT scope.value FROM knowledge_revision current, json_each(current.projects_json) AS scope WHERE current.knowledge_id = ${r}.id AND current.revision = ${r}.revision`],
  knowledge_revision: (r) => [`SELECT value FROM json_each(${r}.projects_json)`, ...proposalScopes(`${r}.proposal_id`)],
  knowledge_proposal: (r) => knowledgeProposal(r),
  knowledge_evidence: (r) => [
    ...proposalScopes(`${r}.proposal_id`),
    `SELECT project_id FROM task WHERE (${r}.source = 'task' AND id = ${r}.ref) OR (${r}.source = 'run' AND id = (SELECT task_id FROM run WHERE id = ${r}.ref))`,
  ],
  usage: (r) => [run(r, 'run_id'), `SELECT project_id FROM router_context WHERE id = ${r}.context_id`],
  project_file: (r) => [`SELECT ${r}.project_id`, message(r, 'message_id')],
  project_files_cleanup: direct,
  work_cleanup: direct,
  im_group_binding: direct,
  change: (r) => [
    task(r, 'task_id'), run(r, 'run_id'), message(r, 'message_id'),
    `SELECT project_id FROM router_call WHERE id = ${r}.tool_call_id`,
    `SELECT json_extract(${r}.detail_json, '$.project_id')`,
  ],
  setting: () => [],
};
const serviceTables = new Set(['account', 'machine_login', 'machine_login_refusal', 'login_state', 'role', 'router_template', 'knowledge_client', 'front_desk', 'im_group_context']);

function direct(row: string): readonly string[] {
  return [`SELECT ${row}.project_id`];
}

function task(row: string, id: string): string {
  return `SELECT project_id FROM task WHERE id = ${row}.${id}`;
}

function run(row: string, id: string): string {
  return `SELECT task.project_id FROM run JOIN task ON task.id = run.task_id WHERE run.id = ${row}.${id}`;
}

function message(row: string, id: string): string {
  return `SELECT project_id FROM message WHERE id = ${row}.${id}`;
}

function knowledgeProposal(row: string, where = ''): readonly string[] {
  const from = where === '' ? '' : `knowledge_proposal ${row}, `;
  const condition = where === '' ? '' : ` AND ${where}`;
  const changes = ['change_json', 'final_json'].flatMap((column) => [
    `SELECT project.value FROM ${from}json_each(${row}.${column}, '$.outputs') AS output,
      json_each(output.value, '$.project_ids') AS project WHERE project.value IS NOT NULL${condition}`,
    `SELECT project.value FROM ${from}json_each(${row}.${column}, '$.inputs') AS input
      JOIN knowledge_revision revision ON revision.knowledge_id = json_extract(input.value, '$.knowledge_id')
      AND (revision.revision = json_extract(input.value, '$.revision')
        OR revision.revision = (SELECT revision FROM knowledge WHERE id = revision.knowledge_id)),
      json_each(revision.projects_json) AS project WHERE project.value IS NOT NULL${condition}`,
  ]);
  if (where === '') return [task(row, 'task_id'), run(row, 'run_id'), ...changes];
  return [
    `SELECT task.project_id FROM knowledge_proposal ${row} JOIN task
       ON task.id = ${row}.task_id OR task.id = (SELECT task_id FROM run WHERE id = ${row}.run_id) WHERE ${where}`,
    ...changes,
  ];
}

function proposalScopes(id: string): readonly string[] {
  return knowledgeProposal('owner_proposal', `owner_proposal.id = ${id}`);
}

export function projectOutboxScopes(row: string): readonly string[] {
  const payload = `${row}.payload_json`;
  // `results` and `remind` wrap original payloads; inspect both before licensing an effect.
  const items = `SELECT ${payload} AS value UNION ALL SELECT value FROM json_each(${payload}, '$.items')`;
  const possible = [
    ['project_id', 'p.id'], ['task_id', 'task.id'], ['run_id', 'run.id'],
    ['message_id', 'message.id'], ['approval_id', 'approval.id'], ['trigger_id', 'trigger_rule.id'],
  ].map(([key, value]) =>
    `${value} IN (json_extract(item.value, '$.${key}'), json_extract(item.value, '$.payload.${key}'))`,
  );
  return [
    `SELECT p.id FROM (${items}) item JOIN project p ON ${possible[0]}
     UNION SELECT task.project_id FROM (${items}) item JOIN task ON ${possible[1]}
     UNION SELECT task.project_id FROM (${items}) item JOIN run ON ${possible[2]} JOIN task ON task.id = run.task_id
     UNION SELECT message.project_id FROM (${items}) item JOIN message ON ${possible[3]}
     UNION SELECT task.project_id FROM (${items}) item JOIN approval ON ${possible[4]} JOIN task ON task.id = approval.task_id
     UNION SELECT trigger_rule.project_id FROM (${items}) item JOIN trigger_rule ON ${possible[5]}`,
  ];
}

export function bindProjectHomeGuard(connection: DatabaseSync, home: ProjectHome) {
  const tables = connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const unknown = tables.filter(({ name }) => typeof name !== 'string' || (!Object.hasOwn(scopes, name) && !serviceTables.has(name)));
  if (unknown.length) throw new Error('这些账本表未声明项目归属：' + unknown.map(({ name }) => name).join('、'));
  const ownership = connection.prepare('SELECT value_json FROM setting WHERE key = ?');
  let refusal: unknown;
  const assertGuarded = (fn: () => void): number => {
    try {
      if (!home.isGuarded()) throw new Error('项目账本写入必须在归属锁内');
      fn();
      return 1;
    } catch (error) {
      refusal = error;
      throw error;
    }
  };
  connection.function('tycho_assert_project_write', (id) => assertGuarded(() => {
    if (typeof id !== 'string') throw new Error('账本行引用了无效的项目');
    const raw = ownership.get(PROJECT_HOME_KEY_PREFIX + id)?.value_json;
    const installed = typeof raw === 'string' ? JSON.parse(raw) as ProjectOwnership : undefined;
    home.assertLedgerWrite(id, installed);
  }));
  connection.function('tycho_assert_project_install', (key, raw) => assertGuarded(() => {
    if (typeof key !== 'string' || typeof raw !== 'string') throw new Error('账本行引用了无效的项目归属');
    home.assertInstall(key.slice(PROJECT_HOME_KEY_PREFIX.length), JSON.parse(raw) as ProjectOwnership);
  }));
  for (const { name } of tables) {
    if (typeof name !== 'string' || !Object.hasOwn(scopes, name)) continue;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      // The old scope may itself be the only scope if an update tries to detach it.
      const rows = operation === 'INSERT' ? ['NEW'] : operation === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
      const statements = name === 'setting'
        ? rows.map((row) => `SELECT tycho_assert_project_install(${row}.key, ${operation === 'UPDATE' ? 'NEW.value_json' : row + '.value_json'})
           WHERE substr(${row}.key, 1, ${PROJECT_HOME_KEY_PREFIX.length}) = '${PROJECT_HOME_KEY_PREFIX}'`)
        : [`SELECT tycho_assert_project_write(project) FROM (
            WITH projects(project) AS (${rows.flatMap(scopes[name]!).join(' UNION ')}) SELECT project FROM projects
          ) WHERE project IS NOT NULL`];
      connection.exec(`
        CREATE TEMP TRIGGER project_guard_${name}_${operation} BEFORE ${operation} ON main."${name}"
        BEGIN
          ${statements.join(';\n          ')};
        END;
      `);
    }
  }
  return {
    takeRefusal(): unknown {
      const captured = refusal;
      refusal = undefined;
      return captured;
    },
  };
}
