import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { TASK_FEEDBACK_LABELS, TASK_FEEDBACK_NOTE_LIMIT, type TaskFeedback, type TaskFeedbackKind } from '@shared/task-feedback.ts';
import { HashLink, Note, Problem, Time } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { useChange } from '@/hooks/use-change';
import { useMounted } from '@/hooks/use-mounted';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PAGE } from '@/lib/queries';

interface Listing { feedback: TaskFeedback[] }
export function TaskFeedbackPanel({ taskId, runs, selectedRun }: {
  taskId: string; runs: readonly { id: string; task_revision: number }[]; selectedRun: string | null;
}) {
  const { t } = useI18n();
  const queryKey = [PAGE, 'task-feedback', taskId];
  const query = useQuery({ queryKey, queryFn: () => api<Listing>(`/api/tasks/${encodeURIComponent(taskId)}/feedback`) });
  const change = useChange<Listing>({ mutationKey: ['task-feedback-change', taskId], queryKey, reread: true });
  const here = useMounted();
  const [kind, setKind] = useState<TaskFeedbackKind>('reuse');
  const [note, setNote] = useState('');
  const [runId, setRunId] = useState(selectedRun ?? '');
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!change.free()) return;
    setError(null);
    try {
      await change.send(() => post<{ feedback: TaskFeedback }>(`/api/tasks/${encodeURIComponent(taskId)}/feedback`, {
        kind, ...(note.trim() ? { note } : {}), ...(runId ? { run_id: runId } : {}),
      }), (page, answer) => ({ feedback: [...page.feedback, answer.feedback] }));
      if (here()) setNote('');
    } catch (problem) {
      if (here()) setError(messageOf(problem));
    }
  }
  return (
    <section aria-label={t('tsk.feedback.sectionLabel')} className="grid gap-3 rounded-xl border border-border p-3.5">
      <Note>{t('tsk.feedback.recordOnlyNote')}</Note>
      <form onSubmit={(event) => void save(event)} className="grid gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('tsk.feedback.kindLabel')}>
          {Object.entries(TASK_FEEDBACK_LABELS).map(([value, label]) => (
            <Button key={value} size="sm" aria-pressed={kind === value} disabled={change.busy}
              onClick={() => setKind(value as TaskFeedbackKind)}>{label}</Button>
          ))}
        </div>
        <label className="grid gap-1 text-sm">{t('tsk.feedback.targetLabel')}
          <Select value={runId} onChange={(event) => setRunId(event.target.value)} disabled={change.busy}>
            <Option value="">{t('tsk.feedback.wholeTask')}</Option>
            {runs.map((run, index) => <Option key={run.id} value={run.id}>{t('tsk.feedback.roundOption', { round: index + 1, revision: run.task_revision })}</Option>)}
          </Select>
        </label>
        <label className="grid gap-1 text-sm">{t('tsk.feedback.noteLabel')}
          <Textarea rows={2} maxLength={TASK_FEEDBACK_NOTE_LIMIT} value={note} onChange={(event) => setNote(event.target.value)} readOnly={change.busy} />
        </label>
        {error ? <Problem role="alert">{error}</Problem> : null}
        <Button type="submit" className="justify-self-start" disabled={change.busy || query.isPending}>{t('tsk.feedback.saveBtn')}</Button>
      </form>
      <Note>{t('tsk.feedback.followupNote')}</Note>
      {query.isPending ? <Note role="status">{t('tsk.feedback.loading')}</Note> : null}
      {query.error ? <div className="grid justify-items-start gap-2"><Problem role="alert">{query.error.message}</Problem>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('tsk.feedback.retryLoad')}</Button></div> : null}
      {query.data?.feedback.length === 0 ? <Note>{t('tsk.feedback.empty')}</Note> : null}
      {query.data?.feedback.length ? <ul aria-label={t('tsk.feedback.savedListLabel')} className="grid gap-3">
        {query.data.feedback.map((item) => <li key={item.id} className="grid gap-1 border-t border-border pt-3 text-sm">
          <p className="font-medium">{TASK_FEEDBACK_LABELS[item.kind]}</p>
          {item.note ? <p className="whitespace-pre-wrap wrap-anywhere">{item.note}</p> : null}
          <Note>{item.run_revision === null ? t('tsk.feedback.metaWholeTask', { taskRev: item.task_revision }) : t('tsk.feedback.metaRound', { taskRev: item.task_revision, runRev: item.run_revision })}</Note>
          <Time at={item.created_at} className="text-xs text-faint" />
          {item.run_id ? <HashLink href={`#/task/${encodeURIComponent(taskId)}?run=${encodeURIComponent(item.run_id)}`}>{t('tsk.feedback.viewSourceRound')}</HashLink> : null}
        </li>)}
      </ul> : null}
    </section>
  );
}
