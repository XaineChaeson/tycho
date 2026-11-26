import type { Ledger } from './ledger.ts';
import type { ChangeRow } from './messages.ts';
import { internalEvents } from '../shared/internal-events.ts';

const STATE_CHANGES = new Set([
  'task.queue', 'task.resume', 'task.hold', 'task.abandon', 'task.accept',
  'task.schedule_wake', 'task.wake', 'approval.open', 'approval.answer',
  'run.create', 'run.running', 'run.stopping', 'run.unknown', 'run.settle', 'run.settle_late',
]);

// The sequence, rather than wall time, distinguishes operations committed in the same millisecond.
export function traceRun(ledger: Ledger, runId: string) {
  const run = ledger.getRun(runId);
  const task = ledger.getTask(run.task_id);
  const snapshot = JSON.parse(run.snapshot_json) as { session_ref?: string };
  const history = ledger.listChanges({ taskId: run.task_id });
  const created = history.find((change) => change.run_id === runId && change.action === 'run.create');
  const changes = created ? history.filter(({ seq }) => seq <= created.seq) : [];
  const triggerChange = created
    ? changes.findLast(({ seq, action }) => seq < created.seq && STATE_CHANGES.has(action)) ?? null
    : null;
  const trigger = describeTrigger(triggerChange);
  const message = triggerChange?.message_id ? ledger.getMessage(triggerChange.message_id) : null;
  const toolCall = task.project_id && triggerChange?.tool_call_id ? ledger.routerCall(task.project_id, triggerChange.tool_call_id) : undefined;
  const taskCreation = history.find(({ action }) => action === 'task.create');
  const originCall = task.project_id && taskCreation?.tool_call_id && taskCreation.tool_call_id !== toolCall?.id
    ? ledger.routerCall(task.project_id, taskCreation.tool_call_id) : undefined;
  const ended = history.find(({ run_id, action }) => run_id === runId && action === 'run.settle');
  const policy = history.find(({ run_id, action }) => run_id === runId && action === 'run.ready_notice');
  const detail = created?.detail_json ? JSON.parse(created.detail_json) as Record<string, unknown> : {};
  return {
    run_id: runId,
    task_id: run.task_id,
    trigger: {
      ...trigger,
      change: triggerChange,
      message: message?.project_id === null || message?.project_id === task.project_id ? message : null,
      tool_call: toolCall ?? null,
    },
    origin_call: originCall ?? null,
    inputs: ledger.listInputs(run.task_id).filter(({ run_id }) => run_id === runId),
    session_ref: snapshot.session_ref ?? null,
    task_revision: run.task_revision,
    dispatchConditions: detail.dispatchConditions ?? null,
    changes,
    settlement: ended ? {
      at: ended.at,
      task_state: ended.detail_json ? (JSON.parse(ended.detail_json) as { task_state?: string }).task_state ?? null : null,
      exit_kind: run.exit_kind,
      policy: policy?.detail_json ? JSON.parse(policy.detail_json) as { rule: string; reason: string } : null,
      delivery: ledger.resultDelivery(internalEvents.workReady(run.task_id, run.id).id),
    } : null,
  };
}

function describeTrigger(change: ChangeRow | null): { kind: 'message' | 'approval' | 'timer' | 'resume' | 'unknown'; label: string } {
  if (change?.action === 'approval.answer') return { kind: 'approval', label: '问题已答复，继续执行' };
  if (change?.action === 'task.wake') return { kind: 'timer', label: '预约到期' };
  if (change?.action === 'task.resume') {
    return change.message_id
      ? { kind: 'message', label: '负责人按消息继续' }
      : { kind: 'resume', label: '人工继续' };
  }
  if (change?.message_id) return { kind: 'message', label: '负责人按消息派发' };
  return { kind: 'unknown', label: '触发来源未记录' };
}
