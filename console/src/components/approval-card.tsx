// A question a task stands on, wherever it shows: in the project's conversation, on the
// overview and on the task's own page. Picking only marks the choice; nothing is sent
// until "提交答复".
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, CircleHelp } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { t as translate } from '@shared/i18n.ts';
import { ACCEPT_WITHOUT_REVIEW_LABEL } from '@shared/review.ts';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PAGE, taskQuery } from '@/lib/queries';
import type { Approval, Question } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Draft {
  choice: string | null;
  other: string;
  otherOpen: boolean;
}

export interface PresentedQuestion {
  title: string;
  detail: string | null;
  hint: string | null;
}

// What the owner has picked or typed into a question, kept while the console is open:
// the same card shows in the conversation, on the overview and on the task page, and a
// half-written answer is not lost by walking between them.
const drafts = new Map<string, Draft>();

const answerOf = (draft: Draft | undefined): string => (!draft ? '' : draft.otherOpen ? draft.other.trim() : draft.choice ?? '');

const LEGACY_REVIEW_HEAD = /^审阅在(.+?)的产物上又打回了，系统不再升档，要你来定：([\s\S]*?)\n\n独立审阅打回了上一轮的产物：[^\n]*(?:\n\n([\s\S]+))?$/; // i18n-ignore
const LEGACY_REVIEW_TAIL = /\n*按这些意见改，改完照常交回执。?\s*$/; // i18n-ignore
const LEGACY_REVIEW_HINT = '回答之后任务回到队列，回答的内容交给下一轮；不想再做就放弃这个任务'; // i18n-ignore

// Format legacy numbered review lines (`1. 违反的要求：...\n   证据：...\n   要改的范围：...`)
// into clean nested Markdown so already-persisted approvals immediately become readable.
function formatLegacyViolations(raw: string): { markdown: string; count: number } {
  const cleaned = raw.replace(LEGACY_REVIEW_TAIL, '').trim();
  if (!cleaned) return { markdown: '', count: 0 };
  const itemPattern = /(?:^|\n)(\d+)\.\s*违反的要求：([^\n]*)(?:\n\s*证据：([^\n]*))?(?:\n\s*要改的范围：([^\n]*))?/g; // i18n-ignore
  const items: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(cleaned)) !== null) {
    const [, num, req, ev, scope] = match;
    const lines = [translate('tsk.approval.legacyViolationReq', { num: num ?? '', req: (req ?? '').trim() })];
    if (ev?.trim()) lines.push(translate('tsk.approval.legacyViolationEv', { evidence: ev.trim() }));
    if (scope?.trim()) lines.push(translate('tsk.approval.legacyViolationScope', { scope: scope.trim() }));
    items.push(lines.join('\n'));
  }
  if (items.length > 0) return { markdown: items.join('\n'), count: items.length };
  return { markdown: cleaned, count: 0 };
}

// Separate a concise heading from structured Markdown detail. Works for both newly structured
// approvals (`question` = heading, `about` = Markdown detail) and legacy multi-line questions
// (including old decide-tier review rejections whose summary was duplicated in `question`).
export function presentQuestion(question: Question): PresentedQuestion {
  const rawQuestion = question.question.trim();
  const rawAbout = question.about?.trim() ?? '';

  const legacyReview = LEGACY_REVIEW_HEAD.exec(rawQuestion);
  if (legacyReview) {
    const [, tier, summaryRaw, bodyRaw = ''] = legacyReview;
    const summary = (summaryRaw ?? '').trim();
    const { markdown: itemsMd, count } = formatLegacyViolations(bodyRaw);
    const parts: string[] = [];
    if (summary) parts.push(translate('tsk.approval.legacyVerdictSummary', { summary }));
    if (itemsMd) parts.push(itemsMd);
    const countPart = count > 0 ? translate('tsk.approval.legacyCountPart', { count }) : '';
    return {
      title: translate('tsk.approval.legacyTitle', { tier: tier ?? '', countPart }),
      detail: parts.length > 0 ? parts.join('\n\n') : null,
      hint: rawAbout || null,
    };
  }

  const firstBreak = rawQuestion.indexOf('\n');
  if (firstBreak !== -1) {
    const head = rawQuestion.slice(0, firstBreak).trim();
    const rest = rawQuestion.slice(firstBreak + 1).trim();
    const isHintOnly = rawAbout === LEGACY_REVIEW_HINT;
    const detailParts = [rest, !isHintOnly ? rawAbout : ''].filter(Boolean);
    return {
      title: head || rawQuestion,
      detail: detailParts.length > 0 ? detailParts.join('\n\n') : null,
      hint: isHintOnly ? rawAbout : null,
    };
  }

  const isHintOnly = rawAbout === LEGACY_REVIEW_HINT;
  return {
    title: rawQuestion,
    detail: !isHintOnly && rawAbout ? rawAbout : null,
    hint: isHintOnly ? rawAbout : null,
  };
}

function shouldCollapseDetail(detail: string): boolean {
  return detail.length > 900 || detail.split('\n').length > 16;
}

// An option is a sentence of the Worker's, as long as it made it: it takes the lines it
// needs and never more than the card's width. The chosen one is outlined in ink.
const OPTION = [
  'flex min-h-hit max-w-full cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-raised px-3 py-1 text-left text-sm shadow-xs transition-colors duration-100',
  'hover:bg-muted aria-pressed:border-primary aria-pressed:bg-brand-soft aria-pressed:font-medium aria-pressed:text-brand-foreground disabled:cursor-default disabled:opacity-50',
].join(' ');

function QuestionDetail({ detail, projectId }: { detail: string; projectId?: string }) {
  const { t } = useI18n();
  const collapsible = shouldCollapseDetail(detail);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 text-sm text-foreground">
      <div className={cn('relative', collapsible && !expanded && 'max-h-72 overflow-hidden')}>
        <Markdown
          text={detail}
          projectId={projectId}
          className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_li]:my-1 [&_ol]:my-1.5 [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:my-1 [&_ul]:pl-5"
        />
        {collapsible && !expanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted/95 to-transparent" aria-hidden="true" />
        ) : null}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
          {expanded ? t('tsk.approval.collapseDetail') : t('tsk.approval.expandAll')}
        </button>
      ) : null}
    </div>
  );
}

function QuestionView({ card, question, index, onChange }: { card: Approval; question: Question; index: number; onChange: () => void }) {
  const { t } = useI18n();
  const key = `${card.id}:${index}`;
  const options = question.options ?? [];
  const other = useRef<HTMLTextAreaElement>(null);
  // Read draft without mutating the module map during render; create an entry only when edited.
  const draft = drafts.get(key) ?? { choice: null, other: '', otherOpen: options.length === 0 };
  const update = (patch: Partial<Draft>): void => {
    drafts.set(key, { ...draft, ...patch });
    onChange();
  };

  const presented = presentQuestion(question);
  const header = (
    <>
      <p className="font-semibold leading-snug text-foreground">{presented.title}</p>
      {presented.detail ? <QuestionDetail detail={presented.detail} projectId={card.project_id ?? undefined} /> : null}
      {presented.hint ? <p className="mt-1.5 text-xs text-muted-foreground">{presented.hint}</p> : null}
    </>
  );
  if (card.state !== 'open') {
    const given = card.answers?.[index];
    return (
      <div>
        {header}
        {given === undefined ? null : <p className="mt-1.5 text-sm">{t('tsk.approval.answerPrefix', { answer: String(given) })}</p>}
      </div>
    );
  }
  return (
    <div>
      {header}
      {options.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((option, optionIndex) => {
            const picked = draft.choice === option && !draft.otherOpen;
            const recommended = optionIndex === question.recommend;
            return (
              <button
                key={optionIndex}
                type="button"
                aria-pressed={picked}
                {...(recommended ? { 'aria-description': t('tsk.approval.recommended') } : {})}
                className={OPTION}
                onClick={() => update({ choice: option, otherOpen: false })}
              >
                {picked ? <Check className="size-3.5 flex-none" aria-hidden="true" /> : null}
                <span className="min-w-0">{option}</span>
                {recommended ? <span aria-hidden="true" className="flex-none rounded-xs bg-hover px-1 text-2xs font-medium text-muted-foreground">{t('tsk.approval.recommended')}</span> : null}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={draft.otherOpen}
            className={cn(OPTION, 'text-muted-foreground aria-pressed:text-foreground')}
            onClick={() => {
              update({ otherOpen: true });
              requestAnimationFrame(() => other.current?.focus());
            }}
          >
            {t('tsk.approval.otherOption')}
          </button>
        </div>
      ) : null}
      <Textarea
        ref={other}
        rows={2}
        hidden={!draft.otherOpen}
        aria-label={t('tsk.approval.otherAria')}
        placeholder={t('tsk.approval.otherPlaceholder')}
        className="mt-2 max-h-[40vh] overflow-y-auto"
        value={draft.other}
        onChange={(event) => update({ other: event.target.value })}
      />
    </div>
  );
}

type DirectAction = 'accept' | 'abandon' | null;

export function ApprovalCard({ card, className }: { card: Approval; className?: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [directAction, setDirectAction] = useState<DirectAction>(null);
  const [directNote, setDirectNote] = useState('');
  const [, redraw] = useState(0);
  const open = card.state === 'open';
  const isReviewEscalation = Boolean(card.review_task_id);

  async function refreshAll(): Promise<void> {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['approvals'] }),
      client.invalidateQueries({ queryKey: [PAGE] }),
      client.invalidateQueries({ queryKey: taskQuery(card.task_id).queryKey }),
    ]);
  }

  async function submit(): Promise<void> {
    const answers = card.questions.map((_, index) => answerOf(drafts.get(`${card.id}:${index}`)));
    if (answers.some((answer) => answer === '')) {
      setFailure(t('tsk.approval.answerAllRequired'));
      return;
    }
    setSending(true);
    try {
      await post(`/api/approvals/${card.id}/answer`, { answers });
      for (let i = 0; i < card.questions.length; i += 1) {
        drafts.delete(`${card.id}:${i}`);
      }
      setFailure(null);
    } catch (error) {
      setFailure(messageOf(error));
    }
    setSending(false);
    void refreshAll();
  }

  async function submitDirect(action: 'accept' | 'abandon'): Promise<void> {
    const note = directNote.trim();
    if (action === 'accept' && !note) {
      setFailure(t('tsk.approval.basisRequired'));
      return;
    }
    setSending(true);
    try {
      const body = action === 'accept' ? { basis: note, without_review: true } : { reason: note };
      await post(`/api/tasks/${encodeURIComponent(card.task_id)}/${action}`, body);
      setFailure(null);
      setDirectAction(null);
      setDirectNote('');
    } catch (error) {
      setFailure(messageOf(error));
    }
    setSending(false);
    void refreshAll();
  }

  return (
    <section
      aria-label={t('tsk.approval.cardAria', { title: card.task_title })}
      data-state={card.state}
      className={cn(
        'overflow-hidden rounded-xl border text-sm wrap-anywhere',
        open ? 'border-waiting-border bg-raised shadow-sm' : 'border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      <div className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b px-3.5 py-2 text-xs', open ? 'border-waiting-border bg-waiting-soft font-medium text-waiting-foreground' : 'border-border')}>
        <CircleHelp className="size-3.5 flex-none" aria-hidden="true" />
        <span className="flex-none">{t('home.waitingYou')}</span>
        <span aria-hidden="true">·</span>
        <Link to={`/task/${encodeURIComponent(card.task_id)}`} className="min-w-0 flex-1 truncate font-normal no-underline hover:underline">{card.task_title}</Link>
        {card.review_task_id ? (
          <Link
            to={`/task/${encodeURIComponent(card.review_task_id)}`}
            className="flex-none rounded px-1.5 py-0.5 text-2xs font-medium no-underline hover:underline"
          >
            {t('tsk.approval.viewReviewReport')}
          </Link>
        ) : null}
      </div>
      <div className="grid gap-3.5 px-3.5 py-3">
        {card.questions.map((question, index) => (
          <QuestionView key={index} card={card} question={question} index={index} onChange={() => redraw((n) => n + 1)} />
        ))}
        {open ? (
          <div className="grid gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={sending} onClick={() => void submit()}>{t('tsk.approval.submitReply')}</Button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {isReviewEscalation ? (
                  <Button
                    variant="ghost"
                    disabled={sending}
                    aria-expanded={directAction === 'accept'}
                    onClick={() => {
                      setFailure(null);
                      setDirectNote('');
                      setDirectAction((current) => (current === 'accept' ? null : 'accept'));
                    }}
                  >
                    {ACCEPT_WITHOUT_REVIEW_LABEL}
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  disabled={sending}
                  aria-expanded={directAction === 'abandon'}
                  onClick={() => {
                    setFailure(null);
                    setDirectNote('');
                    setDirectAction((current) => (current === 'abandon' ? null : 'abandon'));
                  }}
                >
                  {t('tsk.actions.abandonTask')}
                </Button>
              </div>
            </div>
            {directAction === 'accept' ? (
              <div className="grid gap-2 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">{t('tsk.approval.directAcceptHint')}</p>
                <Textarea
                  rows={2}
                  aria-label={t('tsk.actions.acceptWithoutReviewAria')}
                  placeholder={t('tsk.approval.directAcceptPlaceholder')}
                  className="max-h-[30vh] overflow-y-auto"
                  value={directNote}
                  readOnly={sending}
                  onChange={(event) => setDirectNote(event.target.value)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={sending || !directNote.trim()} onClick={() => void submitDirect('accept')}>
                    {sending ? t('common.sending') : t('tsk.actions.confirmPrefix', { label: ACCEPT_WITHOUT_REVIEW_LABEL })}
                  </Button>
                  <Button variant="ghost" disabled={sending} onClick={() => { setDirectAction(null); setFailure(null); }}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : null}
            {directAction === 'abandon' ? (
              <div className="grid gap-2 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">{t('tsk.approval.abandonConfirm')}</p>
                <Textarea
                  rows={2}
                  aria-label={t('tsk.actions.abandonReasonAria')}
                  placeholder={t('tsk.actions.abandonReasonPlaceholder')}
                  className="max-h-[30vh] overflow-y-auto"
                  value={directNote}
                  readOnly={sending}
                  onChange={(event) => setDirectNote(event.target.value)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="danger-solid" disabled={sending} onClick={() => void submitDirect('abandon')}>
                    {sending ? t('common.sending') : t('tsk.actions.confirmAbandon')}
                  </Button>
                  <Button variant="ghost" disabled={sending} onClick={() => { setDirectAction(null); setFailure(null); }}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p>{card.state === 'answered' ? t('tsk.approval.answeredVia', { via: card.answered_via ?? '' }) : t('tsk.approval.closed')}</p>
        )}
        {failure ? <p role="alert" className="text-destructive">{failure}</p> : null}
      </div>
    </section>
  );
}
