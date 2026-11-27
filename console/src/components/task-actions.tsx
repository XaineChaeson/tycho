// What the owner can do to a Task from its work page, its task page and the overview:
// go on, stop, hold, give up, accept, send back to work, or start an independent review.
// Secondary/destructive actions expand focused inline panels on demand instead of sharing
// one ambiguous box or hiding behind disabled buttons.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { taskLine, taskStateLabels } from '@shared/labels.ts';
import { ACCEPT_WITHOUT_REVIEW_LABEL, type ReviewGateKind } from '@shared/review.ts';
import { Note, StatusDot } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { useMounted } from '@/hooks/use-mounted';
import { messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PAGE, taskQuery, tasksQuery } from '@/lib/queries';
import type { ReviewGateInfo, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

const LOGIN_MENTION_RE = /登录|账号|凭据|login|account|credential/i; // i18n-ignore

type TaskAction = 'resume' | 'interrupt' | 'abandon' | 'accept' | 'rework' | 'review' | 'hold';
type InlinePanel = 'accept_without_review' | 'rework' | 'abandon' | null;

// Where a Task stands, in one line: its dot and the sentence the service makes of it.
export function TaskStatus({ task, className }: { task: Task; className?: string }) {
  const { t } = useI18n();
  return (
    <p className={cn('flex items-start gap-2 text-sm text-muted-foreground', className)}>
      <StatusDot state={task.summary?.dot ?? task.state} className="mt-[2px]" />
      <span className="min-w-0 wrap-anywhere">{taskLine(task)}{task.lost?.waiting?.no_candidate ? <> · <Link to={task.project_id ? `/projects/${encodeURIComponent(task.project_id)}/settings` : "/accounts"}>{t('tsk.checkProjectLogins')}</Link></> : null}</span>
    </p>
  );
}

// One action at a time for the page. Failures stay inline on the action bar and preserve
// what the owner typed; success clears the draft and refreshes the task.
export function useTaskAct(taskId: string, after?: () => void) {
  const client = useQueryClient();
  const mounted = useMounted();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedReview, setRequestedReview] = useState<{ taskId: string | null } | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    setError(null);
    setRequestedReview(null);
  }, [taskId]);

  async function act(action: TaskAction, fields: Record<string, unknown> = {}): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true;
    setPending(true);
    setError(null);
    const value = draft.trim();
    const body = action === 'abandon' ? { reason: value, ...fields }
      : action === 'hold' ? { reason: value, ...fields }
      : action === 'accept' ? { basis: value, ...fields }
      : action === 'rework' ? { note: value, ...fields }
      : fields;
    try {
      const result = await post<Record<string, unknown> | undefined>(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, body);
      if (action === 'review') {
        const createdId = typeof result?.task_id === 'string'
          ? result.task_id
          : typeof result?.review_task_id === 'string'
            ? result.review_task_id
            : null;
        if (mounted()) setRequestedReview({ taskId: createdId });
        await Promise.all([
          client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey }),
          client.invalidateQueries({ queryKey: tasksQuery.queryKey }),
          client.invalidateQueries({ queryKey: [PAGE] }),
        ]);
      } else {
        await client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey });
      }
      if (mounted()) setDraft('');
      after?.();
      return true;
    } catch (caught) {
      if (mounted()) setError(messageOf(caught));
      return false;
    } finally {
      lock.current = false;
      if (mounted()) setPending(false);
    }
  }

  return {
    draft,
    pending,
    error,
    requestedReview,
    clearError(): void {
      setError(null);
    },
    act,
    // Nothing typed while an action is on its way changes what was sent with it.
    type(value: string): void {
      if (!lock.current) setDraft(value);
    },
  };
}

export type TaskAct = ReturnType<typeof useTaskAct>;

function resolveGateKind(task: Task, blocked: string | null, gate: ReviewGateInfo | null, justRequested: boolean): ReviewGateKind | null {
  if (justRequested) return 'in_review';
  if (gate?.kind) return gate.kind;
  if (blocked === null) return null;
  return task.active_review ? 'in_review' : 'no_review';
}

function InlineActionPanel({
  panel,
  note,
  pending,
  taskRevision,
  onNoteChange,
  onCancel,
  onSubmit,
}: {
  panel: Exclude<InlinePanel, null>;
  note: string;
  pending: boolean;
  taskRevision: number | undefined;
  onNoteChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (action: 'accept' | 'rework' | 'abandon', fields: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  if (panel === 'accept_without_review') {
    return (
      <div className="grid gap-2 rounded-lg border border-border bg-background/80 p-3">
        <Note className="text-xs">{t('tsk.actions.acceptWithoutReviewNote', { label: ACCEPT_WITHOUT_REVIEW_LABEL })}</Note>
        <Textarea
          rows={2}
          aria-label={t('tsk.actions.acceptWithoutReviewAria')}
          placeholder={t('tsk.actions.acceptWithoutReviewPlaceholder')}
          className="max-h-[30vh] overflow-y-auto"
          value={note}
          readOnly={pending}
          onChange={(event) => onNoteChange(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={pending || !note.trim()}
            onClick={() => void onSubmit('accept', { basis: note.trim(), without_review: true })}
          >
            {pending ? t('common.sending') : t('tsk.actions.confirmPrefix', { label: ACCEPT_WITHOUT_REVIEW_LABEL })}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </div>
    );
  }
  if (panel === 'rework') {
    return (
      <div className="grid gap-2 rounded-lg border border-border bg-background/80 p-3">
        <Textarea
          rows={2}
          aria-label={t('tsk.actions.reworkAria')}
          placeholder={t('tsk.actions.reworkPlaceholder')}
          className="max-h-[30vh] overflow-y-auto"
          value={note}
          readOnly={pending}
          onChange={(event) => onNoteChange(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={pending || !note.trim()}
            onClick={() => void onSubmit('rework', { note: note.trim(), revision: taskRevision })}
          >
            {pending ? t('common.sending') : t('tsk.actions.confirmRework')}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-background/80 p-3">
      <p className="text-xs text-muted-foreground">{t('tsk.actions.abandonConfirm')}</p>
      <Textarea
        rows={2}
        aria-label={t('tsk.actions.abandonReasonAria')}
        placeholder={t('tsk.actions.abandonReasonPlaceholder')}
        className="max-h-[30vh] overflow-y-auto"
        value={note}
        readOnly={pending}
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="danger-solid"
          disabled={pending}
          onClick={() => void onSubmit('abandon', { reason: note.trim() })}
        >
          {pending ? t('common.sending') : t('tsk.actions.confirmAbandon')}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

// What the owner can do for a Task right now:
// - `ready` splits into 4 clear states: auto-reviewing (calm), review held (amber),
//   awaiting review launch (amber + 1-click launch), and truly ready to accept (1-click accept).
// - Every non-ended task (when no run is active, or when needs_verification) exposes 放弃.
// - Queued and waiting_timer tasks also expose a lightweight 暂停 button.
export function TaskActions({
  task,
  active,
  interrupt = true,
  question = false,
  blocked = task.accept_blocked ?? null,
  gate = task.review_gate ?? null,
  control,
  className,
}: {
  task: Task;
  active: boolean;
  interrupt?: boolean;
  question?: boolean;
  blocked?: string | null;
  gate?: ReviewGateInfo | null;
  control: TaskAct;
  className?: string;
}) {
  const { t } = useI18n();
  const { draft, pending, error, requestedReview, clearError, type } = control;
  const [panel, setPanel] = useState<InlinePanel>(null);
  const [panelNote, setPanelNote] = useState('');

  useEffect(() => {
    setPanel(null);
    setPanelNote('');
  }, [task.id, task.state]);

  const ended = ['done', 'abandoned'].includes(task.state);
  const lost = task.state === 'needs_verification';
  const accepting = !lost && !active && task.state === 'ready';
  const parked = task.state === 'waiting_person' && !question;
  const goOn = !active && (task.state === 'held' || parked);
  const canHold = !active && ['queued', 'waiting_timer'].includes(task.state);
  const canAbandon = !ended && (!active || lost);
  const stop = active && interrupt;

  const effectiveGate = gate ?? task.review_gate ?? null;
  const justRequested = requestedReview !== null;
  const gateKind = accepting ? resolveGateKind(task, blocked, effectiveGate, justRequested) : null;
  const gated = accepting && gateKind !== null;
  const reviewTaskId = task.active_review ?? effectiveGate?.review_task_id ?? requestedReview?.taskId ?? null;

  if (!goOn && !accepting && !canHold && !canAbandon && !stop) return null;

  function togglePanel(next: Exclude<InlinePanel, null>): void {
    clearError();
    setPanelNote('');
    setPanel((current) => (current === next ? null : next));
  }

  function closePanel(): void {
    clearError();
    setPanel(null);
    setPanelNote('');
  }

  async function submitPanel(action: 'accept' | 'rework' | 'abandon', fields: Record<string, unknown>): Promise<void> {
    const ok = await control.act(action, fields);
    if (ok) closePanel();
  }

  const inlinePanelNode = panel ? (
    <InlineActionPanel
      panel={panel}
      note={panelNote}
      pending={pending}
      taskRevision={task.revision}
      onNoteChange={(value) => { if (!pending) setPanelNote(value); }}
      onCancel={closePanel}
      onSubmit={submitPanel}
    />
  ) : null;

  const errorNode = error ? <p role="alert" className="text-sm text-destructive wrap-anywhere">{error}</p> : null;

  // State A — 审阅进行中: calm blue/running banner with collapsed manual overrides.
  if (accepting && gateKind === 'in_review') {
    const reviewStateLabel = effectiveGate?.review_state
      ? (taskStateLabels[effectiveGate.review_state] ?? effectiveGate.review_state)
      : null;
    return (
      <section
        aria-label={t('tsk.actions.inReviewAria')}
        className={cn('grid gap-2.5 rounded-xl border border-border bg-muted/50 p-3.5', className)}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot state="running" />
          <p className="text-sm font-semibold text-foreground">{t('tsk.actions.inReviewTitle')}</p>
          {justRequested ? <span className="text-xs font-medium text-success-foreground">{t('tsk.actions.reviewStartedBadge')}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {reviewStateLabel ? <span>{t('tsk.actions.reviewStateLine', { state: reviewStateLabel })}</span> : null}
          {reviewTaskId ? <Link to={`/task/${encodeURIComponent(reviewTaskId)}`}>{t('tsk.actions.viewReviewTask')}</Link> : null}
        </div>
        <details className="group/override text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">{t('tsk.actions.earlyIntervene')}</summary>
          <div className="mt-2.5 grid gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" disabled={pending} aria-expanded={panel === 'accept_without_review'} onClick={() => togglePanel('accept_without_review')}>
                {ACCEPT_WITHOUT_REVIEW_LABEL}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} aria-expanded={panel === 'rework'} onClick={() => togglePanel('rework')}>
                {t('tsk.actions.reworkBtn')}
              </Button>
              <Button size="sm" variant="danger" disabled={pending} aria-expanded={panel === 'abandon'} onClick={() => togglePanel('abandon')}>
                {t('tsk.actions.abandonTask')}
              </Button>
            </div>
            {inlinePanelNode}
          </div>
        </details>
        {errorNode}
      </section>
    );
  }

  // State B — 审阅已停住: amber banner pointing to the held review task + overrides.
  if (accepting && gateKind === 'review_held') {
    const heldReason = effectiveGate?.review_reason ?? effectiveGate?.message ?? blocked;
    const mentionLogin = Boolean(error) || Boolean(heldReason && LOGIN_MENTION_RE.test(heldReason));
    return (
      <section
        aria-label={t('tsk.actions.reviewHeldTitle')}
        className={cn('grid gap-2.5 rounded-xl border border-waiting-border bg-waiting-soft p-3.5', className)}
      >
        <p className="text-sm font-semibold text-waiting-foreground">{t('tsk.actions.reviewHeldTitle')}</p>
        {heldReason ? <Note className="text-foreground">{heldReason}</Note> : null}
        <div className="flex flex-wrap items-center gap-2">
          {reviewTaskId ? (
            <Button variant="primary" asChild>
              <Link to={`/task/${encodeURIComponent(reviewTaskId)}`} className="no-underline">{t('tsk.actions.goHandleReview')}</Link>
            </Button>
          ) : null}
          <Button variant="ghost" disabled={pending} aria-expanded={panel === 'accept_without_review'} onClick={() => togglePanel('accept_without_review')}>
            {ACCEPT_WITHOUT_REVIEW_LABEL}
          </Button>
          <Button variant="ghost" disabled={pending} aria-expanded={panel === 'rework'} onClick={() => togglePanel('rework')}>
            {t('tsk.actions.reworkBtn')}
          </Button>
          <Button variant="danger" className="ml-auto" disabled={pending} aria-expanded={panel === 'abandon'} onClick={() => togglePanel('abandon')}>
            {t('tsk.actions.abandonTask')}
          </Button>
        </div>
        {mentionLogin ? <Note className="text-xs"><Link to="/accounts">{t('tsk.actions.checkAvailableLogins')}</Link></Note> : null}
        {inlinePanelNode}
        {errorNode}
      </section>
    );
  }

  // State C — 待发起审阅 (no_review | stale_pass): clear card with 1-click launch + overrides.
  if (accepting && gated) {
    const explanation = effectiveGate?.message ?? blocked ?? t('tsk.actions.noReviewExplanation');
    const mentionLogin = Boolean(error) || LOGIN_MENTION_RE.test(explanation);
    return (
      <section
        aria-label={t('tsk.actions.acceptAria')}
        className={cn('grid gap-2.5 rounded-xl border border-waiting-border bg-waiting-soft p-3.5', className)}
      >
        <p className="text-sm font-semibold text-waiting-foreground">
          {gateKind === 'stale_pass' ? t('tsk.actions.stalePassTitle') : t('tsk.actions.needsReviewTitle')}
        </p>
        <Note className="text-foreground">{explanation}</Note>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={pending} onClick={() => void control.act('review')}>
            {pending ? t('tsk.common.startingEllipsis') : t('tsk.actions.startReviewBtn')}
          </Button>
          <Button variant="ghost" disabled={pending} aria-expanded={panel === 'accept_without_review'} onClick={() => togglePanel('accept_without_review')}>
            {ACCEPT_WITHOUT_REVIEW_LABEL}
          </Button>
          <Button variant="ghost" disabled={pending} aria-expanded={panel === 'rework'} onClick={() => togglePanel('rework')}>
            {t('tsk.actions.reworkBtn')}
          </Button>
          <Button variant="danger" className="ml-auto" disabled={pending} aria-expanded={panel === 'abandon'} onClick={() => togglePanel('abandon')}>
            {t('tsk.actions.abandonTask')}
          </Button>
        </div>
        {mentionLogin ? <Note className="text-xs"><Link to="/accounts">{t('tsk.actions.checkAvailableLogins')}</Link></Note> : null}
        {inlinePanelNode}
        {errorNode}
      </section>
    );
  }

  // State D — 真正待验收: 1-click accept with optional basis + progressive-disclosure rework & abandon.
  if (accepting) {
    return (
      <section
        aria-label={t('tsk.actions.acceptAria')}
        className={cn('grid gap-2.5 rounded-xl border border-waiting-border bg-waiting-soft p-3.5', className)}
      >
        <p className="text-sm font-semibold text-waiting-foreground">{t('tsk.actions.readyToAcceptTitle')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Textarea
            rows={1}
            className="max-h-[30vh] w-auto min-w-[180px] flex-1 overflow-y-auto"
            value={draft}
            readOnly={pending}
            placeholder={t('tsk.actions.acceptNotePlaceholder')}
            aria-label={t('tsk.actions.acceptBasisAria')}
            onChange={(event) => type(event.target.value)}
          />
          <Button variant="primary" disabled={pending} onClick={() => void control.act('accept')}>
            {pending ? t('common.sending') : t('tsk.actions.acceptPassBtn')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={pending} aria-expanded={panel === 'rework'} onClick={() => togglePanel('rework')}>
            {t('tsk.actions.reworkBtn')}
          </Button>
          <Button variant="danger" className="ml-auto" disabled={pending} aria-expanded={panel === 'abandon'} onClick={() => togglePanel('abandon')}>
            {t('tsk.actions.abandonBtn')}
          </Button>
        </div>
        {inlinePanelNode}
        {errorNode}
      </section>
    );
  }

  // Non-ready states: resume (held/parked), hold (queued/waiting_timer), interrupt (active), abandon (all non-ended).
  const subtleBar = !goOn && !lost && !stop;
  return (
    <section
      aria-label={t('tsk.actions.handleTaskAria')}
      className={cn(
        'grid gap-2.5 rounded-xl border p-3.5',
        goOn || lost ? 'border-border bg-muted' : stop && !canAbandon && !canHold ? 'border-transparent p-0' : subtleBar ? 'border-border/70 bg-muted/40' : 'border-border bg-muted',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {goOn ? <Button variant="primary" disabled={pending} onClick={() => void control.act('resume')}>{t('task.btnContinue')}</Button> : null}
        {canHold ? <Button variant="secondary" disabled={pending} onClick={() => void control.act('hold', { reason: '' })}>{t('common.pause')}</Button> : null}
        {stop ? <Button disabled={pending} onClick={() => void control.act('interrupt')}>{t('tsk.actions.interruptBtn')}</Button> : null}
        {canAbandon ? (
          <Button variant="danger" className="ml-auto" disabled={pending} aria-expanded={panel === 'abandon'} onClick={() => togglePanel('abandon')}>
            {t('tsk.actions.abandonBtn')}
          </Button>
        ) : null}
      </div>
      {inlinePanelNode}
      {errorNode}
    </section>
  );
}

// A work waiting to be accepted, as the overview and work page show it: the answer is typed
// and sent where the work is seen, without opening its page first.
export function AcceptNow({ task, context }: { task: Task; context?: string | undefined }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const control = useTaskAct(task.id, () => { void client.invalidateQueries({ queryKey: [PAGE] }); });
  const { draft, pending, error, type } = control;
  const effectiveGate = task.review_gate ?? null;
  const inReview = effectiveGate?.kind === 'in_review' || Boolean(task.active_review);
  const reviewHeld = effectiveGate?.kind === 'review_held';
  const reviewTaskId = task.active_review ?? effectiveGate?.review_task_id ?? null;

  if (inReview) {
    return (
      <section className="overflow-hidden rounded-xl border border-border bg-raised shadow-sm" aria-label={t('tsk.actions.acceptNowInReviewAria', { title: task.title })}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5 text-sm">
          <StatusDot state="running" className="size-3.5" />
          <Link to={`/task/${encodeURIComponent(task.id)}`} className="font-medium no-underline wrap-anywhere hover:underline">{task.title}</Link>
          <span className="text-xs text-muted-foreground">{t('tsk.actions.autoReviewing')}</span>
          <Link to={reviewTaskId ? `/task/${encodeURIComponent(reviewTaskId)}` : `/task/${encodeURIComponent(task.id)}`} className="ml-auto text-xs">
            {t('tsk.actions.viewReviewTask')}
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-waiting-border bg-raised shadow-sm" aria-label={t('tsk.actions.acceptNowReadyAria', { title: task.title })}>
      <p className="flex items-center gap-1.5 border-b border-waiting-border bg-waiting-soft px-3.5 py-2 text-xs font-medium text-waiting-foreground">
        <StatusDot state="ready" className="size-3.5" />
        {reviewHeld ? t('tsk.actions.reviewHeldTitle') : t('home.readyReview')}
        {context ? <span className="min-w-0 truncate font-normal">{`· ${context}`}</span> : null}
      </p>
      <div className="grid gap-2.5 px-3.5 py-3">
        <div>
          <Link to={`/task/${encodeURIComponent(task.id)}`} className="font-semibold no-underline wrap-anywhere hover:underline">{task.title}</Link>
          {task.latest_run?.receipt?.summary ? <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground wrap-anywhere">{task.latest_run.receipt.summary}</p> : null}
        </div>
        {reviewHeld ? (
          <p className="text-sm">
            {effectiveGate?.review_reason ?? effectiveGate?.message ?? task.accept_blocked ?? t('tsk.actions.reviewHeldTitle')}{' '}
            <Link to={reviewTaskId ? `/task/${encodeURIComponent(reviewTaskId)}` : `/task/${encodeURIComponent(task.id)}`}>{t('tsk.actions.goHandleReview')}</Link>
          </p>
        ) : task.accept_blocked || effectiveGate ? (
          <p className="text-sm">
            {effectiveGate?.message ?? task.accept_blocked}{' '}
            <Link to={`/task/${encodeURIComponent(task.id)}`}>{t('tsk.actions.goRequestReview')}</Link>
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Textarea
              rows={1}
              className="max-h-[30vh] w-auto min-w-[160px] flex-1 overflow-y-auto"
              value={draft}
              readOnly={pending}
              placeholder={t('tsk.actions.acceptNotePlaceholder')}
              aria-label={t('tsk.actions.acceptBasisAria')}
              onChange={(event) => type(event.target.value)}
            />
            <Button variant="primary" disabled={pending} onClick={() => void control.act('accept')}>{pending ? t('common.sending') : t('tsk.actions.acceptPassBtn')}</Button>
          </div>
        )}
        {error ? <p role="alert" className="text-sm text-destructive wrap-anywhere">{error}</p> : null}
      </div>
    </section>
  );
}
