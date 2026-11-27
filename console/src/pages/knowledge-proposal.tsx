// One change as the owner reads it (docs/design/knowledge-and-skills.md §3, §5.2). What needs
// the owner comes first — the one decision when it waits for them, or the mark that they have
// read it — then how it got here (the outcome, an earlier rejection, why it waits, the gate's
// verdict), then the change itself: the entries it touches and where each goes, what it puts
// out, what that costs (the lines it drops, how each project and role's input moves), why it
// was proposed and the evidence.
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  DISPOSITION_LABELS, LOADING_LABELS, OWNER_REASON_LABELS, PROPOSAL_STATE_LABELS, SOURCE_LABELS, WHY_QUESTIONS, citation,
} from '@shared/knowledge.ts';
import { localeMap } from '@shared/i18n.ts';
import { Callout, Details, Mono, Note, PRE, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import {
  CandidateFields, EvidenceList, FORM_LEGEND, FORM_PART, candidateBody, loadingText, candidateMissing, changeTitle, draftOf, entryPath, keepDraft, kib, proposalPath,
  reviewText, rolesText, sameCandidate, scopeOf, useKnowledgeAction, type CandidateDraft, type KnowledgeAction, type Names,
} from '@/components/knowledge-bits';
import { Markdown } from '@/components/markdown';
import { PageBar, PageBody, PageTitle } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { diffLines } from '@/lib/line-diff';
import { knowledgeQuery, proposalQuery } from '@/lib/queries';
import type { ChangeOutput, KnowledgeChange, KnowledgeEntry, KnowledgeProposal, KnowledgeProposalPage, KnowledgeWhy } from '@/lib/types';
import { cn } from '@/lib/utils';

// Where a decision was made, in words. A channel this page does not know is shown as named.
const VIA_LABELS: Readonly<Record<string, string>> = localeMap({
  console: 'know.proposal.via.console',
  wecom: 'know.proposal.via.wecom',
  weixin: 'know.proposal.via.weixin',
  task_abandon: 'know.proposal.via.taskAbandon',
});

type Inputs = KnowledgeProposalPage['inputs'];

// A line of a diff reaches the edges of its box, so what came and what went read as bands.
const DIFF_LINE = '-mx-3 block min-h-[1.65em] px-3 no-underline';

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className={cn(PRE, 'mt-1.5')}>
      {diffLines(before, after).map((line, index) => {
        const mark = <span aria-hidden="true" className="mr-2 text-faint select-none">{line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' '}</span>;
        if (line.kind === 'removed') return <del key={index} className={cn(DIFF_LINE, 'bg-failed-soft text-failed-foreground')}>{mark}{line.text}</del>;
        if (line.kind === 'added') return <ins key={index} className={cn(DIFF_LINE, 'bg-success-soft text-success-foreground')}>{mark}{line.text}</ins>;
        return <span key={index} className={DIFF_LINE}>{mark}{line.text}</span>;
      })}
    </pre>
  );
}

const scopeLine = (names: Names | undefined, output: Pick<ChangeOutput, 'project_ids' | 'loading'>, kind: KnowledgeChange['kind']): string =>
  `${scopeOf(names, output.project_ids, [])} · ${loadingText(kind, output.loading)}`;

function OutputList({ change, inputs, names }: { change: KnowledgeChange; inputs: Inputs; names: Names | undefined }) {
  const { t } = useI18n();
  if (!change.outputs.length) return <Note>{t('know.proposal.noOutputs')}</Note>;
  return (
    <Rows>
      {change.outputs.map((output) => {
        const base = output.revises === null ? undefined : inputs.find((input) => input.knowledge_id === output.revises);
        return (
          <article key={output.key} aria-label={output.title} className="min-w-0 px-3.5 py-3">
            <h3 className="font-semibold wrap-anywhere">{output.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
              {output.revises === null ? t('know.proposal.outputNew') : t('know.proposal.outputRevises', { ref: citation(output.revises, base?.revision ?? 0) })}
              {t('know.proposal.outputMeta', { scope: scopeLine(names, output, change.kind), roles: rolesText(names, output.roles) })}
            </p>
            {output.when_to_use ? <p className="mt-2 text-sm wrap-anywhere"><span className="text-muted-foreground">{t('know.entry.whenToUsePrefix')}</span>{output.when_to_use}</p> : null}
            <Markdown text={output.body} className="mt-2" />
          </article>
        );
      })}
    </Rows>
  );
}

function InputList({ inputs, change, entries }: { inputs: Inputs; change: KnowledgeChange; entries: readonly KnowledgeEntry[] }) {
  const { t } = useI18n();
  const nameOf = (ref: string): string => change.outputs.find((output) => output.key === ref)?.title ?? entries.find((each) => each.id === ref)?.title ?? ref;
  return (
    <Rows>
      <ul className="divide-y divide-border">
        {inputs.map((input) => {
          const title = input.pinned?.title ?? input.now?.title ?? input.knowledge_id;
          const moved = input.now !== null && (input.now.revision !== input.revision || input.now.state !== 'active');
          return (
            <li key={input.knowledge_id} aria-label={title} className="min-w-0 px-3.5 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={input.disposition === 'keep' ? 'plain' : 'waiting'}>{DISPOSITION_LABELS[input.disposition]}</Badge>
                <Link to={entryPath(input.knowledge_id)} className="font-semibold wrap-anywhere">{title}</Link>
                <Mono className="text-muted-foreground">{citation(input.knowledge_id, input.revision)}</Mono>
              </div>
              {input.replaced_by ? <p className="mt-1 wrap-anywhere">{t('know.proposal.replacedBy', { target: nameOf(input.replaced_by) })}</p> : null}
              {input.note ? <p className="mt-1 text-muted-foreground wrap-anywhere">{input.note}</p> : null}
              {moved && input.now ? (
                <p className="mt-1 text-waiting-foreground wrap-anywhere">
                  {t(input.now.state === 'retired' ? 'know.proposal.inputMovedRetired' : 'know.proposal.inputMoved', { ref: citation(input.now.id, input.now.revision) })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Rows>
  );
}

function Changes({ change, inputs, names }: { change: KnowledgeChange; inputs: Inputs; names: Names | undefined }) {
  const { t } = useI18n();
  const revising = change.outputs.filter((output) => output.revises !== null);
  if (!revising.length) return <Note>{t('know.proposal.noRevisionsToDiff')}</Note>;
  return (
    <div className="grid grid-cols-1 gap-5">
      {revising.map((output) => {
        const input = inputs.find((each) => each.knowledge_id === output.revises);
        const base = input?.pinned;
        const at = citation(output.revises!, input?.revision ?? 0);
        if (!base) return <Note key={output.key}>{t('know.proposal.cannotReadBase', { title: output.title, ref: at })}</Note>;
        const fields: [string, string, string][] = [[t('know.field.title'), base.title, output.title], [t('know.field.whenToUse'), base.when_to_use, output.when_to_use], [t('know.field.body'), base.body, output.body]];
        const changed = fields.filter(([, before, after]) => before !== after);
        const wasScope = scopeOf(names, base.project_ids, base.roles);
        const isScope = scopeOf(names, output.project_ids, output.roles);
        return (
          <div key={output.key} className="text-sm">
            <p className="wrap-anywhere">{t('know.proposal.diffAgainst', { title: output.title })}<Mono>{at}</Mono></p>
            {wasScope !== isScope ? <p className="mt-2 wrap-anywhere">{t('know.proposal.scopeChanged', { before: wasScope, after: isScope })}</p> : null}
            {change.kind === 'knowledge' && base.loading !== output.loading ? <p className="mt-2">{t('know.proposal.loadingChanged', { before: LOADING_LABELS[base.loading], after: LOADING_LABELS[output.loading] })}</p> : null}
            {changed.length ? changed.map(([label, before, after]) => (
              <div key={label} className="mt-3">
                <h3 className="text-xs text-faint">{label}</h3>
                <Diff before={before} after={after} />
              </div>
            )) : <Note className="mt-2">{t('know.proposal.noTextChanges')}</Note>}
          </div>
        );
      })}
    </div>
  );
}

function Impact({ impact }: { impact: KnowledgeProposalPage['impact'] }) {
  const { t } = useI18n();
  return (
    <>
      <section aria-label={t('know.proposal.droppedTitle')}>
        <SectionTitle>{t('know.proposal.droppedTitle')}</SectionTitle>
        {impact.dropped.length ? (
          <div className="grid gap-3">
            {impact.dropped.map((each) => (
              <div key={each.knowledge_id}>
                <h3 className="text-sm font-semibold wrap-anywhere">{t('know.proposal.entryWithDisposition', { title: each.title, disposition: DISPOSITION_LABELS[each.disposition] })}</h3>
                <ul className="mt-1 grid gap-0.5 border-l-2 border-failed-border pl-3 text-sm">
                  {each.lines.map((line, index) => <li key={index} className="wrap-anywhere">{line}</li>)}
                </ul>
              </div>
            ))}
          </div>
        ) : <Note>{t('know.proposal.nothingDropped')}</Note>}
      </section>
      <section aria-label={t('know.proposal.impactTitle')}>
        <SectionTitle>{t('know.proposal.impactTitle')}</SectionTitle>
        <Note className="-mt-1 mb-2 text-xs">{impact.kind === 'actual'
          ? t('know.proposal.impactActualNote')
          : t('know.proposal.impactForecastNote')}</Note>
        {impact.combos.length ? (
          // Four columns do not fit a phone: the table scrolls inside its own box.
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[30rem] border-collapse text-left text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">{t('know.field.project')}</th>
                  <th className="px-3 py-1.5 font-semibold">{t('know.field.role')}</th>
                  <th className="px-3 py-1.5 font-semibold">{t('know.proposal.colBriefKnowledge')}</th>
                  <th className="px-3 py-1.5 font-semibold">{t('know.proposal.colSnapshotFiles')}</th>
                </tr>
              </thead>
              <tbody>
                {impact.combos.map((each) => (
                  <tr key={`${each.project_id}:${each.role_id}`} className="border-t border-border">
                    <td className="px-3 py-1.5">{each.project}</td>
                    <td className="px-3 py-1.5">{each.role}</td>
                    <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{`${kib(each.before.brief)} → ${kib(each.after.brief)}`}</td>
                    <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{`${kib(each.before.files)} → ${kib(each.after.files)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Note>{t('know.proposal.noImpact')}</Note>}
      </section>
    </>
  );
}

function Gate({ page, names, entries }: { page: KnowledgeProposalPage; names: Names | undefined; entries: readonly KnowledgeEntry[] }) {
  const { t } = useI18n();
  const { proposal, gate_task: task } = page;
  const { gate } = proposal;
  const taskId = gate?.task_id ?? task?.id ?? proposal.gate_task_id;
  if (!gate && !taskId) return null;
  return (
    <section aria-label={t('know.proposal.gateTitle')} className="text-sm">
      <SectionTitle>{t('know.proposal.gateTitle')}</SectionTitle>
      {gate ? (
        <>
          <p className="wrap-anywhere">{t('know.proposal.gateVerdictPrefix')}<Badge tone={gate.result === 'pass' ? 'success' : 'failed'}>{gate.result === 'pass' ? t('know.proposal.gatePass') : t('know.proposal.gateReject')}</Badge></p>
          <p className="mt-1 text-muted-foreground wrap-anywhere">{gate.reason}</p>
          {gate.modified ? (
            <>
              <p className="mt-2 text-waiting-foreground">{t('know.proposal.gateModifiedNote')}</p>
              <Details id={`knowledge-submitted:${proposal.id}`} title={t('know.proposal.viewSubmitted')}>
                <div className="pb-2">
                  <OutputList change={proposal.change} inputs={page.inputs} names={names} />
                  {proposal.change.inputs.length ? (
                    <p className="mt-2 text-xs text-muted-foreground wrap-anywhere">
                      {t('know.proposal.submittedInputs', {
                        items: proposal.change.inputs
                          .map((each) => t('know.proposal.entryWithDisposition', {
                            title: entries.find((entry) => entry.id === each.knowledge_id)?.title ?? each.knowledge_id,
                            disposition: DISPOSITION_LABELS[each.disposition],
                          }))
                          .join(t('know.listSep')),
                      })}
                    </p>
                  ) : null}
                </div>
              </Details>
            </>
          ) : null}
        </>
      ) : (
        <p className="wrap-anywhere">{task?.reason ? t('know.proposal.gatingWithReason', { reason: task.reason }) : t('know.proposal.gating')}</p>
      )}
      {taskId ? <Link to={`/task/${encodeURIComponent(taskId)}`} className="mt-1 inline-block">{t('know.proposal.viewGateTask')}</Link> : null}
    </section>
  );
}

function Outcome({ proposal }: { proposal: KnowledgeProposal }) {
  const { t } = useI18n();
  const via = proposal.decided_via === null ? '' : VIA_LABELS[proposal.decided_via] ?? proposal.decided_via;
  const decided = proposal.decided_by !== null && (proposal.state === 'published' || proposal.state === 'rejected');
  if (!proposal.state_reason && proposal.state !== 'stale' && !proposal.amended_from && proposal.state !== 'superseded' && !decided) return null;
  return (
    <div className="grid gap-2">
      {proposal.state_reason ? <Note>{proposal.state_reason}</Note> : null}
      {proposal.state === 'stale' ? <Note>{t('know.proposal.staleNote')}</Note> : null}
      {proposal.amended_from ? <Note>{t('know.proposal.amendedFromNote')}<Link to={proposalPath(proposal.amended_from)} className="ml-1">{t('know.proposal.viewOriginal')}</Link></Note> : null}
      {proposal.state === 'superseded' ? (
        <Note>
          {t('know.proposal.supersededNote')}
          {proposal.next_id ? <Link to={proposalPath(proposal.next_id)} className="ml-1">{t('know.proposal.viewNewer')}</Link> : null}
        </Note>
      ) : null}
      {decided ? (
        <Callout tone="plain" role="region" aria-label={t('know.proposal.outcomeAria')}>
          <p className="wrap-anywhere">
            {via
              ? t('know.proposal.decidedLineVia', { state: PROPOSAL_STATE_LABELS[proposal.state], by: proposal.decided_by, via })
              : t('know.proposal.decidedLine', { state: PROPOSAL_STATE_LABELS[proposal.state], by: proposal.decided_by })}
            <Time at={proposal.decided_at} />
          </p>
          {proposal.decision_note ? <blockquote className="mt-1.5 border-l-2 border-border-strong pl-3 text-muted-foreground wrap-anywhere">{proposal.decision_note}</blockquote> : null}
        </Callout>
      ) : null}
    </div>
  );
}

// `other`: the third way to settle it, beside agreeing and turning it down.
function Decide({ proposal, action, other }: { proposal: KnowledgeProposal; action: KnowledgeAction; other: ReactNode }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const decide = (decision: 'approve' | 'reject') => action.run(() => post(`/api/knowledge/proposals/${encodeURIComponent(proposal.id)}/decide`, {
    decision,
    // What takes effect, as the owner was shown it: a change that differs is not the one decided.
    digest: proposal.final_digest ?? proposal.digest,
    ...(note.trim() ? { note: note.trim() } : {}),
  }));
  return (
    <Callout tone="waiting" role="region" aria-label={t('know.proposal.decideTitle')} title={t('know.proposal.decideTitle')} className="grid gap-2.5">
      <Textarea aria-label={t('know.proposal.noteOptional')} rows={2} className="max-h-[40vh] overflow-y-auto" placeholder={t('know.proposal.noteOptional')} value={note} disabled={action.busy} onChange={(event) => setNote(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => void decide('approve')}>{t('know.proposal.approve')}</Button>
        <Button variant="danger" disabled={action.busy} onClick={() => void decide('reject')}>{t('know.proposal.reject')}</Button>
        {other ? <span className="ml-auto">{other}</span> : null}
      </div>
    </Callout>
  );
}

// The owner's own version of a change still in the gate or waiting: the same inputs, pinned to
// the revision each is at now, and outputs as edited. It takes effect at once (§3). It is a
// drawer beside the page, there while it is mounted.
function Amend({ proposal, change, inputs, names, action, onClose }: {
  proposal: KnowledgeProposal; change: KnowledgeChange; inputs: Inputs; names: Names; action: KnowledgeAction; onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [loaded] = useState<CandidateDraft[]>(() => change.outputs.map((output) => draftOf(output, change.kind)));
  const [drafts, setDrafts] = useState<CandidateDraft[]>(loaded);
  const unchanged = drafts.every((draft, index) => sameCandidate(draft, loaded[index]!));
  const missing = drafts.some((draft) => candidateMissing(draft).length > 0);
  const save = () => action.run(
    () => post<{ id: string }>(`/api/knowledge/proposals/${encodeURIComponent(proposal.id)}/amend`, {
      inputs: inputs.map((input) => ({ knowledge_id: input.knowledge_id, revision: input.now?.revision ?? input.revision, disposition: input.disposition, replaced_by: input.replaced_by, note: input.note })),
      outputs: change.outputs.map((output, index) => ({ key: output.key, revises: output.revises, ...candidateBody(drafts[index]!) })),
    }),
    (answer) => { void navigate(proposalPath(answer.id)); },
  );
  return (
    <Sheet open onOpenChange={(open) => { if (!open && !action.busy) onClose(); }}>
      <SheetContent
        title={t('know.proposal.amendTitle')}
        description={t('know.proposal.amendDesc')}
        {...keepDraft}
        footer={(
          <>
            {action.error ? <Problem role="alert" className="basis-full">{action.error}</Problem> : null}
            <Button variant="primary" disabled={action.busy || unchanged || missing} onClick={() => void save()}>{action.busy ? t('know.saving') : t('know.bits.saveAndPublish')}</Button>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>{t('common.cancel')}</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-4">
          {drafts.map((draft, index) => (
            <fieldset key={change.outputs[index]!.key} className={FORM_PART}>
              <legend className={FORM_LEGEND}>{t('know.proposal.outputSeq', { n: index + 1 })}</legend>
              <CandidateFields draft={draft} names={names} disabled={action.busy} onChange={(next) => setDrafts(drafts.map((each, at) => (at === index ? next : each)))} />
            </fieldset>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const WHY_KEYS = Object.keys(WHY_QUESTIONS) as (keyof KnowledgeWhy)[];

export function ProposalPage({ id }: { id: string }) {
  const { t } = useI18n();
  const { data, isPending, error } = useQuery(proposalQuery(id));
  // The names scopes are shown by, and the entries titles are read from.
  const { data: library } = useQuery(knowledgeQuery);
  // One for the decision, the review and the amend: what the service refused stays said after
  // the page reads again and the change has moved on.
  const action = useKnowledgeAction();
  const [amending, setAmending] = useState(false);
  const proposal = data?.proposal;
  const entries = library?.entries ?? [];
  const change = proposal ? proposal.final ?? proposal.change : null;
  const title = proposal && change ? changeTitle(change, entries, proposal.id) : '';
  const open = proposal?.state === 'gating' || proposal?.state === 'awaiting_owner';
  // The drawer is the owner's while the change can still be amended; a refusal is said in it.
  const drawer = open && amending && library !== undefined;

  function body() {
    if (!data || !proposal || !change) return null;
    const amend = open && library && change.outputs.length > 0
      ? <Button disabled={action.busy} onClick={() => { action.clear(); setAmending(true); }}>{t('know.proposal.amendBtn')}</Button>
      : null;
    return (
      <article>
        <header>
          <PageTitle>{title}</PageTitle>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={proposal.state === 'awaiting_owner' ? 'waiting' : proposal.state === 'gating' ? 'running' : 'ended'}>{PROPOSAL_STATE_LABELS[proposal.state]}</Badge>
            {proposal.state === 'published' ? <Badge tone={proposal.reviewed_at === null ? 'waiting' : 'plain'}>{reviewText(proposal.reviewed_at)}</Badge> : null}
            <span className="text-xs text-muted-foreground wrap-anywhere">
              {`${SOURCE_LABELS[proposal.source] ?? proposal.source} · ${proposal.proposed_by} · `}
              <Time at={proposal.created_at} prefix={t('know.proposal.proposedPrefix')} />
            </span>
            {proposal.task_id ? <Link to={`/task/${encodeURIComponent(proposal.task_id)}`} className="text-xs">{t('know.proposal.viewSourceTask')}</Link> : null}
          </div>
        </header>
        <div className="mt-5 grid grid-cols-1 gap-4">
          {!open && action.error && !drawer ? <Problem role="alert">{action.error}</Problem> : null}
          {open ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-waiting-border bg-waiting-soft/60 px-3.5 py-2 text-xs text-waiting-foreground">
              <span>{t('know.proposal.reviewBanner')}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-waiting-foreground hover:not-disabled:bg-waiting/15"
                onClick={() => {
                  const target = document.getElementById('proposal-decide');
                  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  target?.focus();
                }}
              >
                {t('know.proposal.jumpToDecide')}
              </Button>
            </div>
          ) : null}
          {proposal.state === 'published' && proposal.reviewed_at === null ? (
            <div>
              <Button disabled={action.busy} onClick={() => void action.run(() => post(`/api/knowledge/proposals/${encodeURIComponent(proposal.id)}/review`))}>{t('know.markReviewed')}</Button>
            </div>
          ) : null}
          <Outcome proposal={proposal} />
          {proposal.prior_rejection ? (
            <Callout tone="waiting" role="region" aria-label={t('know.proposal.priorRejectionAria')}>
              <p className="wrap-anywhere">
                {t('know.proposal.priorRejectionText', { reason: proposal.prior_rejection.reason ?? t('know.proposal.noReasonGiven') })}
                <Link to={proposalPath(proposal.prior_rejection.id)} className="ml-2">{t('know.proposal.viewThatProposal')}</Link>
              </p>
            </Callout>
          ) : null}
        </div>
        <div className="mt-8 grid grid-cols-1 gap-8">
          {proposal.owner_reasons.length ? (
            <section aria-label={t('know.proposal.ownerReasonsAria')} className="text-sm">
              <SectionTitle>{t('know.proposal.ownerReasonsTitle')}</SectionTitle>
              <ul className="grid gap-0.5">{proposal.owner_reasons.map((reason) => <li key={reason} className="wrap-anywhere">{OWNER_REASON_LABELS[reason]}</li>)}</ul>
            </section>
          ) : null}
          <Gate page={data} names={library} entries={entries} />
          {data.inputs.length ? (
            <section aria-label={t('know.proposal.inputsAria')}>
              <SectionTitle>{t('know.proposal.inputsTitle')}</SectionTitle>
              <InputList inputs={data.inputs} change={change} entries={entries} />
            </section>
          ) : null}
          <section aria-label={t('know.proposal.outputsAria')}>
            <SectionTitle>{proposal.state === 'published' ? t('know.proposal.outputsPublished') : t('know.proposal.outputsPending')}</SectionTitle>
            <OutputList change={change} inputs={data.inputs} names={library} />
          </section>
          <section aria-label={t('know.proposal.diffTitle')}>
            <SectionTitle>{t('know.proposal.diffTitle')}</SectionTitle>
            <Changes change={change} inputs={data.inputs} names={library} />
          </section>
          <Impact impact={data.impact} />
          {WHY_KEYS.some((key) => proposal.why[key]) ? (
            <section aria-label={t('know.proposal.whyTitle')}>
              <SectionTitle>{t('know.proposal.whyTitle')}</SectionTitle>
              <dl className="grid gap-2.5 text-sm">
                {WHY_KEYS.filter((key) => proposal.why[key]).map((key) => (
                  <div key={key}>
                    <dt className="text-muted-foreground">{WHY_QUESTIONS[key]}</dt>
                    <dd className="mt-0.5 wrap-anywhere whitespace-pre-wrap">{proposal.why[key]}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <section aria-label={t('know.field.evidence')}>
            <SectionTitle>{t('know.proposal.evidenceSummary', { total: proposal.evidence.length, verified: proposal.evidence.filter((each) => each.verified).length })}</SectionTitle>
            <EvidenceList evidence={proposal.evidence} />
          </section>
        </div>
        {open ? (
          <div id="proposal-decide" tabIndex={-1} className="mt-8 grid grid-cols-1 gap-4 scroll-mt-4 outline-none">
            {action.error && !drawer ? <Problem role="alert">{action.error}</Problem> : null}
            <Decide proposal={proposal} action={action} other={amend} />
          </div>
        ) : null}
        {drawer ? <Amend proposal={proposal} change={change} inputs={data.inputs} names={library} action={action} onClose={() => setAmending(false)} /> : null}
      </article>
    );
  }

  return (
    <>
      <PageBar crumbs={[{ label: t('knowledge.title'), to: '/knowledge' }, ...(title ? [{ label: title }] : [])]} />
      <PageBody width="narrow" loading={isPending} failure={error?.message}>{body()}</PageBody>
    </>
  );
}
