export const TASK_FEEDBACK_LABELS = {
  reuse: '值得复用',
  slow: '哪里等太久',
  incorrect: '结论有误',
} as const;
export type TaskFeedbackKind = keyof typeof TASK_FEEDBACK_LABELS;
export const TASK_FEEDBACK_NOTE_LIMIT = 2048;

export interface TaskFeedback {
  id: string;
  created_at: string;
  actor: string;
  task_id: string;
  task_revision: number;
  run_id: string | null;
  run_revision: number | null;
  kind: TaskFeedbackKind;
  note: string | null;
}
