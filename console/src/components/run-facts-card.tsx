// Quiet-by-default execution facts card ("执行病历") for a Task page, with an inline editable
// knowledge proposal form backed by `POST /api/knowledge/proposals`.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  GLOBAL_LABEL, KIND_LABELS, KNOWLEDGE_KINDS, LOADINGS, LOADING_LABELS, WHY_QUESTIONS,
  type KnowledgeKind, type Loading, type ProposalState,
} from '@shared/knowledge.ts';
import type { KnowledgeProposalDraft, KnowledgeProposalDraftEvidence, TaskRunFacts } from '@shared/run-facts.ts';
import { Card, Field, Mono, Note, Problem, SectionTitle } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { useMounted } from '@/hooks/use-mounted';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { createRequestId } from '@/lib/ids';
import { KNOWLEDGE, PAGE } from '@/lib/queries';

interface EditableProposal {
  kind: KnowledgeKind;
  loading: Loading;
  title: string;
  when_to_use: string;
  body: string;
  project_ids: string[] | null;
  roles: string[];
  why: { when: string; changes: string; generalizes: string };
  evidence: KnowledgeProposalDraftEvidence[];
  requestId: string;
}

interface ProposalResponse {
  id: string;
  duplicate: boolean;
  state: ProposalState;
}

function editableFromDraft(draft: KnowledgeProposalDraft, projectId: string | null): EditableProposal {
  const first = draft.outputs[0];
  return {
    kind: draft.kind,
    loading: draft.kind === 'skill' ? 'on_demand' : (first?.loading ?? 'on_demand'),
    title: first?.title ?? '',
    when_to_use: first?.when_to_use ?? '',
    body: first?.body ?? '',
    project_ids: first ? first.project_ids : (projectId ? [projectId] : null),
    roles: first?.roles ?? [],
    why: {
      when: draft.why.when,
      changes: draft.why.changes,
      generalizes: draft.why.generalizes,
    },
    evidence: draft.evidence,
    requestId: draft.request_id ?? createRequestId(),
  };
}

function submittedMessageKey(state: ProposalState): string {
  if (state === 'published') return 'tsk.facts.submittedPublished';
  if (state === 'gating' || state === 'awaiting_owner') return 'tsk.facts.submittedQueue';
  return 'tsk.facts.submittedGeneric';
}

export function RunFactsCard({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const mounted = useMounted();
  const sending = useRef(false);
  const kindOptions = KNOWLEDGE_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }));
  const loadingOptions = LOADINGS.map((value) => ({ value, label: LOADING_LABELS[value] }));

  const query = useQuery({
    queryKey: [PAGE, 'task-facts', taskId],
    queryFn: () => api<TaskRunFacts>(`/api/tasks/${encodeURIComponent(taskId)}/facts`),
    retry: false,
  });

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditableProposal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ProposalResponse | null>(null);

  useEffect(() => {
    setEditing(false);
    setForm(null);
    setSubmitting(false);
    setSubmitError(null);
    setSubmitted(null);
  }, [taskId]);

  const facts = query.data;
  const incompleteRuns = facts?.coverage?.incomplete_runs ?? 0;
  if (query.isPending || query.isError || !facts || (!facts.noteworthy && incompleteRuns === 0)) return null;

  if (!facts.noteworthy) {
    return (
      <Note className="text-xs">
        {facts.coverage?.reasons.length
          ? t('tsk.facts.incompleteNoteWithReasons', { count: incompleteRuns, reasons: facts.coverage.reasons.join(t('tsk.facts.reasonSep')) })
          : t('tsk.facts.incompleteNote', { count: incompleteRuns })}
      </Note>
    );
  }

  const reworkRejectCount = facts.ping_pong.filter((item) => item.kind !== 'escalation').length;

  const openForm = (): void => {
    if (!facts.proposal_draft) return;
    setForm(editableFromDraft(facts.proposal_draft, projectId ?? facts.project_id));
    setSubmitError(null);
    setEditing(true);
  };

  const canSubmit = form !== null
    && form.title.trim() !== ''
    && form.body.trim() !== '';

  async function submitProposal(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!form || !canSubmit || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setSubmitError(null);

    const payload: KnowledgeProposalDraft = {
      kind: form.kind,
      inputs: [],
      outputs: [
        {
          title: form.title.trim(),
          when_to_use: form.when_to_use.trim(),
          body: form.body.trim(),
          project_ids: form.project_ids,
          loading: form.kind === 'skill' ? 'on_demand' : form.loading,
          roles: form.roles,
        },
      ],
      why: {
        when: form.why.when.trim(),
        changes: form.why.changes.trim(),
        generalizes: form.why.generalizes.trim(),
      },
      evidence: form.evidence,
      request_id: form.requestId,
    };

    try {
      const answer = await post<ProposalResponse>('/api/knowledge/proposals', payload);
      void client.invalidateQueries({ queryKey: KNOWLEDGE });
      if (mounted()) {
        setSubmitted(answer);
        setEditing(false);
      }
    } catch (error) {
      if (mounted()) setSubmitError(messageOf(error));
    } finally {
      sending.current = false;
      if (mounted()) setSubmitting(false);
    }
  }

  return (
    <Card aria-label={t('tsk.facts.title')} className="grid gap-3">
      <SectionTitle
        count={facts.analyzed_runs}
        className="mb-0"
        action={<Badge tone="waiting">{t('tsk.facts.noteworthyBadge')}</Badge>}
      >
        {t('tsk.facts.title')}
      </SectionTitle>

      {facts.noteworthy_reasons.length > 0 ? (
        <ul aria-label={t('tsk.facts.reasonsLabel')} className="flex flex-wrap gap-1.5">
          {facts.noteworthy_reasons.map((reason, index) => (
            <li key={index}>
              <Badge tone="plain" className="whitespace-normal">{reason}</Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>{t('tsk.facts.analyzedRounds', { count: facts.analyzed_runs })}</span>
        {incompleteRuns > 0 ? <span>{t('tsk.facts.incompleteRounds', { count: incompleteRuns })}</span> : null}
        {facts.failed_rounds > 0 ? <span>{t('tsk.facts.failedRounds', { count: facts.failed_rounds })}</span> : null}
        {reworkRejectCount > 0 ? <span>{t('tsk.facts.reworkRejects', { count: reworkRejectCount })}</span> : null}
        {facts.escalations > 0 ? <span>{t('tsk.facts.escalations', { count: facts.escalations })}</span> : null}
        {facts.tool_repeats.length > 0 ? <span>{t('tsk.facts.toolAnomalies', { count: facts.tool_repeats.length })}</span> : null}
      </div>

      {incompleteRuns > 0 && facts.coverage?.reasons.length ? (
        <Note className="text-xs">{t('tsk.facts.coverageNote', { reasons: facts.coverage.reasons.join(t('tsk.facts.reasonSep')) })}</Note>
      ) : null}

      {facts.tool_repeats.length > 0 ? (
        <div className="grid gap-1 border-t border-border pt-2.5">
          <p className="text-xs font-medium text-muted-foreground">{t('tsk.facts.toolRepeatsHeading')}</p>
          <ul className="grid gap-1 text-xs">
            {facts.tool_repeats.slice(0, 5).map((item, index) => (
              <li key={`${item.run_id}:${item.name}:${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 wrap-anywhere">
                <Mono>{item.name}</Mono>
                <span className="min-w-0 flex-1 text-foreground">{item.normalized_title}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t('tsk.facts.execCount', { count: item.count })}
                  {item.error_count > 0 ? t('tsk.facts.failCountSuffix', { count: item.error_count }) : ''}
                  {item.consecutive_errors >= 2 ? t('tsk.facts.consecutiveFailSuffix', { count: item.consecutive_errors }) : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {facts.error_facts.length > 0 ? (
        <div className="grid gap-1 border-t border-border pt-2.5">
          <p className="text-xs font-medium text-muted-foreground">{t('tsk.facts.errorFactsHeading')}</p>
          <ul className="grid gap-1.5 text-xs">
            {facts.error_facts.slice(0, 5).map((item) => (
              <li key={item.signature} className="grid gap-0.5 wrap-anywhere">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <Badge tone="failed" className="tabular-nums">{`×${item.count}`}</Badge>
                  <span className="min-w-0 flex-1 text-foreground">{item.sample}</span>
                </div>
                <span className="text-muted-foreground">
                  {t('tsk.facts.firstSeenRound')}
                  <Mono>{item.first_run_id}</Mono>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-t border-border pt-2.5">
        {submitted ? (
          <p role="status" className="text-sm text-foreground">
            {t(submittedMessageKey(submitted.state))}
            <Link to="/knowledge" className="font-medium underline underline-offset-2">
              {t('tsk.facts.viewKnowledge')}
            </Link>
          </p>
        ) : !editing && facts.proposal_draft ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={openForm}>{t('tsk.facts.proposeBtn')}</Button>
            <Note className="text-xs">{t('tsk.facts.proposeHint')}</Note>
          </div>
        ) : editing && form ? (
          <form onSubmit={(event) => void submitProposal(event)} className="grid gap-3">
            <Field label={t('tsk.facts.kindLabel')}>
              <div>
                <Segmented
                  label={t('tsk.facts.kindLabel')}
                  value={form.kind}
                  options={kindOptions}
                  disabled={submitting}
                  onChange={(kind) => setForm({
                    ...form,
                    kind,
                    loading: kind === 'skill' ? 'on_demand' : form.loading,
                  })}
                />
              </div>
            </Field>

            {form.kind === 'knowledge' ? (
              <Field label={t('tsk.facts.loadingLabel')}>
                <div>
                  <Segmented
                    label={t('tsk.facts.loadingLabel')}
                    value={form.loading}
                    options={loadingOptions}
                    disabled={submitting}
                    onChange={(loading) => setForm({ ...form, loading })}
                  />
                </div>
              </Field>
            ) : (
              <Note className="text-xs">{t('tsk.facts.skillOnDemandNote')}</Note>
            )}

            <Field label={t('tsk.facts.titleLabel')} htmlFor="run-facts-title">
              <Input
                id="run-facts-title"
                aria-label={t('tsk.facts.titleAria')}
                value={form.title}
                disabled={submitting}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </Field>

            <Field label={t('tsk.facts.whenToUseLabel')} htmlFor="run-facts-when-to-use">
              <Textarea
                id="run-facts-when-to-use"
                aria-label={t('tsk.facts.whenToUseLabel')}
                rows={2}
                value={form.when_to_use}
                disabled={submitting}
                onChange={(event) => setForm({ ...form, when_to_use: event.target.value })}
              />
            </Field>

            <Field label={t('tsk.facts.bodyLabel')} htmlFor="run-facts-body">
              <Textarea
                id="run-facts-body"
                aria-label={t('tsk.facts.bodyAria')}
                rows={5}
                value={form.body}
                disabled={submitting}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </Field>

            <Field label={WHY_QUESTIONS.when} htmlFor="run-facts-why-when">
              <Textarea
                id="run-facts-why-when"
                aria-label={WHY_QUESTIONS.when}
                rows={2}
                value={form.why.when}
                disabled={submitting}
                onChange={(event) => setForm({ ...form, why: { ...form.why, when: event.target.value } })}
              />
            </Field>

            <Field label={WHY_QUESTIONS.changes}>
              <Textarea
                aria-label={WHY_QUESTIONS.changes}
                rows={2}
                value={form.why.changes}
                disabled={submitting}
                onChange={(event) => setForm({ ...form, why: { ...form.why, changes: event.target.value } })}
              />
            </Field>

            <Field label={WHY_QUESTIONS.generalizes}>
              <Textarea
                aria-label={WHY_QUESTIONS.generalizes}
                rows={2}
                value={form.why.generalizes}
                disabled={submitting}
                onChange={(event) => setForm({ ...form, why: { ...form.why, generalizes: event.target.value } })}
              />
            </Field>

            <div className="grid gap-1.5 rounded-lg border border-border bg-muted/40 p-2.5 text-xs">
              <p className="text-muted-foreground">
                {t('tsk.facts.scopeBanner', {
                  scope: form.project_ids === null
                    ? GLOBAL_LABEL
                    : t('tsk.facts.scopeProject', { projects: form.project_ids.join(t('tsk.facts.projectSep')) }),
                })}
              </p>
              <p className="font-medium text-muted-foreground">{t('tsk.facts.evidenceHeading', { count: form.evidence.length })}</p>
              <ul className="grid gap-1">
                {form.evidence.map((ev, index) => (
                  <li key={index} className="wrap-anywhere text-foreground">
                    <span className="text-muted-foreground">
                      {ev.ref
                        ? t('tsk.facts.evidenceRefPrefix', { location: ev.location, ref: ev.ref })
                        : t('tsk.facts.evidencePrefix', { location: ev.location })}
                    </span>
                    {ev.excerpt}
                  </li>
                ))}
              </ul>
            </div>

            {submitError ? <Problem role="alert">{submitError}</Problem> : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={submitting || !canSubmit}>
                {submitting ? t('tsk.facts.publishing') : t('tsk.facts.publishBtn')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => { setEditing(false); setSubmitError(null); }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
