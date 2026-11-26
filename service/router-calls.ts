import type { Db } from './db.ts';
import { createHash } from 'node:crypto';
import { nowIso } from './db.ts';
import { InputError } from './errors.ts';
import type { RouterCallTrace, RouterExchangeOutcome, RouterToolCatalog, RouterTurnTrace } from '../shared/trajectory.ts';
import type { Tools } from './tools.ts';

const TEMPLATE_KIND = 'tycho.router-template.v1';

function readTemplate(text: string): { template: string; tool_catalog: RouterToolCatalog | null } {
  try {
    const stored = JSON.parse(text) as { kind?: unknown; template?: unknown; tool_catalog?: RouterToolCatalog };
    if (stored?.kind === TEMPLATE_KIND && typeof stored.template === 'string'
      && stored.tool_catalog?.basis === 'service_available' && Array.isArray(stored.tool_catalog.tools)) {
      return { template: stored.template, tool_catalog: stored.tool_catalog };
    }
  } catch { /* Rows written before catalogs hold the plain fixed prompt. */ }
  return { template: text, tool_catalog: null };
}

export interface RouterCallStart {
  id: string;
  projectId: string;
  messageId: string;
  messageIds: string[];
  contextId: string | null;
  name: string;
  request: string | null;
}

export interface TaskOperation {
  key: string;
  hash: string;
}

export function createRouterCalls(db: Db, write: <T>(fn: () => T) => T) {
  type Call = Omit<RouterCallTrace, 'receipt_confirmed' | 'committed' | 'message_ids'> & { message_ids_json: string; receipt_at: string | null };
  const callFields = 'id, name, started_at, request, result, result_state, receipt_at, finished_at, message_ids_json';
  function showCall(call: Call): RouterCallTrace {
    const committed = db.all<RouterCallTrace['committed'][number]>(
      'SELECT action, task_id, run_id, at FROM change WHERE tool_call_id = ? ORDER BY seq', call.id,
    );
    const { message_ids_json, receipt_at, ...detail } = call;
    return { ...detail, message_ids: JSON.parse(message_ids_json) as string[], receipt_confirmed: receipt_at !== null, committed };
  }

  return {
    startRouterExchange(exchange: {
      id: string; messageId: string; contextId: string; phase: 'material' | 'request'; input: string; template: string; tools?: ReturnType<Tools['list']>;
    }): void {
      write(() => {
        // The existing content-addressed template also holds the Tycho definitions
        // available for this exchange. It never means tools/list actually happened.
        const text = exchange.tools === undefined ? exchange.template : JSON.stringify({ kind: TEMPLATE_KIND,
          template: exchange.template, tool_catalog: { basis: 'service_available', tools: exchange.tools } });
        const hash = createHash('sha256').update(text).digest('hex');
        db.run('INSERT OR IGNORE INTO router_template (hash, text) VALUES (?, ?)', hash, text);
        db.run(
          'INSERT INTO router_exchange (id, message_id, context_id, phase, started_at, input, template_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
          exchange.id, exchange.messageId, exchange.contextId, exchange.phase, nowIso(), exchange.input, hash,
        );
      });
    },

    finishRouterExchange(id: string, outcome: RouterExchangeOutcome, reply: string | null): void {
      write(() => db.run(
        'UPDATE router_exchange SET outcome = ?, output = ?, finished_at = ? WHERE id = ?',
        outcome, reply, nowIso(), id,
      ));
    },

    routerTurnTrace(projectId: string, messageId: string, after: string | null): RouterTurnTrace {
      const internal = db.get('SELECT 1 FROM message WHERE id = ? AND project_id = ? AND channel = ?', messageId, projectId, 'internal');
      const shared = internal ? db.get<{ message_id: string }>(`
        WITH last_take AS (
          SELECT detail_json FROM change WHERE action = 'message.take'
          AND json_extract(detail_json, '$.message_id') = ? ORDER BY seq DESC LIMIT 1
        )
        SELECT first.id AS message_id FROM last_take
        JOIN message item ON item.id = ? AND item.project_id = ? AND item.channel = 'internal'
        JOIN message first ON first.id = json_extract(last_take.detail_json, '$.turn_message_id')
          AND first.project_id = item.project_id AND first.segment_id = item.segment_id`, messageId, messageId, projectId) : undefined;
      const anchor = shared?.message_id ?? messageId;
      if (after !== null && !db.get('SELECT 1 FROM router_call WHERE id = ? AND project_id = ? AND message_id = ?', after, projectId, anchor)) {
        throw new InputError('调用游标无效，或不属于当前回合');
      }
      const exchanges = after === null ? db.all<Omit<RouterTurnTrace['exchanges'][number], 'tool_catalog'>>(`
        SELECT x.id, x.phase, x.started_at, x.input, t.text AS template, x.output, x.outcome, x.finished_at
        FROM router_exchange x JOIN router_context c ON c.id = x.context_id JOIN router_template t ON t.hash = x.template_hash
        JOIN message m ON m.id = x.message_id
        WHERE m.project_id = ? AND m.id = ? AND c.project_id = m.project_id ORDER BY x.id`, projectId, anchor)
        .map(({ template, ...exchange }) => ({ ...exchange, ...readTemplate(template) })) : [];
      const calls = db.all<Call>(`SELECT ${callFields} FROM router_call
        WHERE project_id = ? AND message_id = ? AND id > ? ORDER BY id LIMIT 21`, projectId, anchor, after ?? '');
      return { message_id: messageId, turn_message_id: anchor, exchanges, calls: calls.slice(0, 20).map(showCall), next_call: calls.length > 20 ? calls[19]!.id : null };
    },
    startRouterCall(call: RouterCallStart): void {
      write(() => db.run(
        'INSERT INTO router_call (id, project_id, message_id, message_ids_json, context_id, name, started_at, request) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        call.id, call.projectId, call.messageId, JSON.stringify(call.messageIds), call.contextId, call.name, nowIso(), call.request,
      ));
    },

    // A response written by the service is not an acknowledgement by the model.
    finishRouterCall(id: string, state: NonNullable<RouterCallTrace['result_state']>, result: string | null): void {
      write(() => db.run(
        'UPDATE router_call SET result_state = ?, result = ?, finished_at = ? WHERE id = ?',
        state, result, nowIso(), id,
      ));
    },

    confirmRouterCall(projectId: string, messageId: string, contextId: string, id: string): void {
      write(() => db.run("UPDATE router_call SET receipt_at = ? WHERE id = ? AND project_id = ? AND message_id = ? AND context_id = ? AND receipt_at IS NULL AND result_state IN ('returned', 'refused')",
        nowIso(), id, projectId, messageId, contextId));
    },

    routerCall(projectId: string, id: string): RouterCallTrace | undefined {
      const call = db.get<Call>(`SELECT ${callFields} FROM router_call WHERE project_id = ? AND id = ?`, projectId, id);
      return call ? showCall(call) : undefined;
    },

    taskOperation(projectId: string, operation: TaskOperation): string | undefined {
      const held = db.get<{ operation_hash: string; operation_result: string }>(
        'SELECT operation_hash, operation_result FROM router_call WHERE project_id = ? AND operation_key = ?',
        projectId, operation.key,
      );
      if (!held) return undefined;
      if (held.operation_hash !== operation.hash) throw new InputError('该操作编号已用于不同的建任务参数');
      return held.operation_result;
    },

    // The task and its replay receipt are in the same transaction as task.create/task.queue.
    saveTaskOperation(id: string, operation: TaskOperation, result: string): void {
      db.run('UPDATE router_call SET operation_key = ?, operation_hash = ?, operation_result = ? WHERE id = ?',
        operation.key, operation.hash, result, id);
    },
  };
}
