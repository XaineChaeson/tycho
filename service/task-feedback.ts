import { TASK_FEEDBACK_LABELS, TASK_FEEDBACK_NOTE_LIMIT, type TaskFeedback, type TaskFeedbackKind } from '../shared/task-feedback.ts';
import { writeChange, type Ctx, type Db } from './db.ts';
import { InputError } from './errors.ts';
import { projectStoppedIn } from './messages.ts';

type FeedbackRow = Pick<TaskFeedback, 'id' | 'created_at' | 'actor' | 'task_id' | 'run_id'> & { detail_json: string };
const fields = 'id, created_at, actor, task_id, run_id, detail_json';
function feedbackOf(row: FeedbackRow): TaskFeedback {
  const detail = JSON.parse(row.detail_json) as Pick<TaskFeedback, 'kind' | 'note' | 'task_revision' | 'run_revision'>;
  return { id: row.id, created_at: row.created_at, actor: row.actor, task_id: row.task_id, run_id: row.run_id,
    kind: detail.kind, note: detail.note, task_revision: detail.task_revision, run_revision: detail.run_revision };
}

// Feedback is an observation on an existing task/round, stored in its original audit.
// It neither changes the task revision nor schedules work or publishes knowledge.
export function createTaskFeedback(db: Db, write: <T>(fn: () => T) => T) {
  function taskOf(id: string) {
    const task = db.get<{ id: string; project_id: string | null; revision: number }>('SELECT id, project_id, revision FROM task WHERE id = ?', id);
    if (!task) throw new InputError(`任务不存在：${id}`);
    return task;
  }
  return {
    addTaskFeedback(taskId: string, input: unknown, ctx: Ctx): TaskFeedback {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('反馈应为对象');
      const raw = input as Record<string, unknown>;
      if (Object.keys(raw).some((key) => !['kind', 'note', 'run_id'].includes(key))) throw new InputError('反馈只能填写类型、说明和轮次');
      if (typeof raw.kind !== 'string' || !Object.hasOwn(TASK_FEEDBACK_LABELS, raw.kind)) throw new InputError('请选择反馈类型');
      if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > TASK_FEEDBACK_NOTE_LIMIT)) throw new InputError(`反馈说明最多 ${TASK_FEEDBACK_NOTE_LIMIT} 字符`);
      if (raw.run_id !== undefined && (typeof raw.run_id !== 'string' || raw.run_id === '')) throw new InputError('反馈轮次编号无效');
      const kind = raw.kind as TaskFeedbackKind;
      const note = typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note : null;
      const runId = raw.run_id as string | undefined;
      return write(() => {
        const task = taskOf(taskId);
        if (projectStoppedIn(db, task.project_id) === 'archived') throw new InputError('项目已归档，恢复后再记录反馈');
        const run = runId === undefined ? null : db.get<{ task_id: string; task_revision: number }>('SELECT task_id, task_revision FROM run WHERE id = ? AND task_id = ?', runId, taskId);
        if (runId !== undefined && !run) throw new InputError('反馈轮次不属于这个任务，或已不存在');
        writeChange(db, 'task.feedback', ctx, { taskId, ...(runId === undefined ? {} : { runId }) }, {
          project_id: task.project_id, kind, note, task_revision: task.revision, run_id: runId ?? null, run_revision: run?.task_revision ?? null,
        });
        return feedbackOf(db.get<FeedbackRow>(`SELECT ${fields} FROM change WHERE task_id = ? AND action = 'task.feedback' ORDER BY rowid DESC LIMIT 1`, taskId)!);
      });
    },
    listTaskFeedback(taskId: string): TaskFeedback[] {
      taskOf(taskId);
      return db.all<FeedbackRow>(`SELECT ${fields} FROM change WHERE task_id = ? AND action = 'task.feedback' ORDER BY rowid`, taskId).map(feedbackOf);
    },
  };
}
