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
import { diffLines } from '@/lib/line-diff';
import { knowledgeQuery, proposalQuery } from '@/lib/queries';
import type { ChangeOutput, KnowledgeChange, KnowledgeEntry, KnowledgeProposal, KnowledgeProposalPage, KnowledgeWhy } from '@/lib/types';
import { cn } from '@/lib/utils';

// Where a decision was made, in words. A channel this page does not know is shown as named.
const VIA_LABELS: Record<string, string> = {
  console: '控制台',
  wecom: '企业微信',
  weixin: '微信',
  task_abandon: '放弃把关任务',
};

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
  if (!change.outputs.length) return <Note>没有输出：这份变更只退役或取代现有条目。</Note>;
  return (
    <Rows>
      {change.outputs.map((output) => {
        const base = output.revises === null ? undefined : inputs.find((input) => input.knowledge_id === output.revises);
        return (
          <article key={output.key} aria-label={output.title} className="min-w-0 px-3.5 py-3">
            <h3 className="font-semibold wrap-anywhere">{output.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
              {output.revises === null ? '新增' : `修订 ${citation(output.revises, base?.revision ?? 0)}`}
              {` · ${scopeLine(names, output, change.kind)} · 职能：${rolesText(names, output.roles)}`}
            </p>
            {output.when_to_use ? <p className="mt-2 text-sm wrap-anywhere"><span className="text-muted-foreground">什么时候用：</span>{output.when_to_use}</p> : null}
            <Markdown text={output.body} className="mt-2" />
          </article>
        );
      })}
    </Rows>
  );
}

function InputList({ inputs, change, entries }: { inputs: Inputs; change: KnowledgeChange; entries: readonly KnowledgeEntry[] }) {
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
              {input.replaced_by ? <p className="mt-1 wrap-anywhere">{`被 ${nameOf(input.replaced_by)} 取代`}</p> : null}
              {input.note ? <p className="mt-1 text-muted-foreground wrap-anywhere">{input.note}</p> : null}
              {moved && input.now ? (
                <p className="mt-1 text-waiting-foreground wrap-anywhere">{`这条已经变了：现在是 ${citation(input.now.id, input.now.revision)}${input.now.state === 'retired' ? '，已退役' : ''}`}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Rows>
  );
}

function Changes({ change, inputs, names }: { change: KnowledgeChange; inputs: Inputs; names: Names | undefined }) {
  const revising = change.outputs.filter((output) => output.revises !== null);
  if (!revising.length) return <Note>没有修订现有条目：新增的条目没有旧修订可比。</Note>;
  return (
    <div className="grid grid-cols-1 gap-5">
      {revising.map((output) => {
        const input = inputs.find((each) => each.knowledge_id === output.revises);
        const base = input?.pinned;
        const at = citation(output.revises!, input?.revision ?? 0);
        if (!base) return <Note key={output.key}>{`读不到 ${output.title} 依据的修订 ${at}。`}</Note>;
        const fields: [string, string, string][] = [['标题', base.title, output.title], ['什么时候用', base.when_to_use, output.when_to_use], ['正文', base.body, output.body]];
        const changed = fields.filter(([, before, after]) => before !== after);
        const wasScope = scopeOf(names, base.project_ids, base.roles);
        const isScope = scopeOf(names, output.project_ids, output.roles);
        return (
          <div key={output.key} className="text-sm">
            <p className="wrap-anywhere">{`${output.title}：对照 `}<Mono>{at}</Mono></p>
            {wasScope !== isScope ? <p className="mt-2 wrap-anywhere">{`作用域：${wasScope} → ${isScope}`}</p> : null}
            {change.kind === 'knowledge' && base.loading !== output.loading ? <p className="mt-2">{`加载方式：${LOADING_LABELS[base.loading]} → ${LOADING_LABELS[output.loading]}`}</p> : null}
            {changed.length ? changed.map(([label, before, after]) => (
              <div key={label} className="mt-3">
                <h3 className="text-xs text-faint">{label}</h3>
                <Diff before={before} after={after} />
              </div>
            )) : <Note className="mt-2">标题、什么时候用和正文都没有改。</Note>}
          </div>
        );
      })}
    </div>
  );
}

function Impact({ impact }: { impact: KnowledgeProposalPage['impact'] }) {
  return (
    <>
      <section aria-label="被删掉的条件">
        <SectionTitle>被删掉的条件</SectionTitle>
        {impact.dropped.length ? (
          <div className="grid gap-3">
            {impact.dropped.map((each) => (
              <div key={each.knowledge_id}>
                <h3 className="text-sm font-semibold wrap-anywhere">{`${each.title}（${DISPOSITION_LABELS[each.disposition]}）`}</h3>
                <ul className="mt-1 grid gap-0.5 border-l-2 border-failed-border pl-3 text-sm">
                  {each.lines.map((line, index) => <li key={index} className="wrap-anywhere">{line}</li>)}
                </ul>
              </div>
            ))}
          </div>
        ) : <Note>没有删掉哪一行：被修订、取代或退役的条目，每一行都还在输出里。</Note>}
      </section>
      <section aria-label="输入的增减">
        <SectionTitle>输入的增减</SectionTitle>
        <Note className="-mt-1 mb-2 text-xs">{impact.kind === 'actual'
          ? '按派发时的算法，每个受影响的项目和职能，一轮带上的知识在生效那一刻前后的真实大小。'
          : '当前影响预测：按派发时的算法，在现在生效的条目上算出它生效后每个受影响的项目和职能一轮带上的知识各有多大。'}</Note>
        {impact.combos.length ? (
          // Four columns do not fit a phone: the table scrolls inside its own box.
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[30rem] border-collapse text-left text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">项目</th>
                  <th className="px-3 py-1.5 font-semibold">职能</th>
                  <th className="px-3 py-1.5 font-semibold">brief 里的知识</th>
                  <th className="px-3 py-1.5 font-semibold">快照里的文件</th>
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
        ) : <Note>没有哪个项目和职能的输入变了。</Note>}
      </section>
    </>
  );
}

function Gate({ page, names, entries }: { page: KnowledgeProposalPage; names: Names | undefined; entries: readonly KnowledgeEntry[] }) {
  const { proposal, gate_task: task } = page;
  const { gate } = proposal;
  const taskId = gate?.task_id ?? task?.id ?? proposal.gate_task_id;
  if (!gate && !taskId) return null;
  return (
    <section aria-label="把关" className="text-sm">
      <SectionTitle>把关</SectionTitle>
      {gate ? (
        <>
          <p className="wrap-anywhere">{'结论：'}<Badge tone={gate.result === 'pass' ? 'success' : 'failed'}>{gate.result === 'pass' ? '通过' : '驳回'}</Badge></p>
          <p className="mt-1 text-muted-foreground wrap-anywhere">{gate.reason}</p>
          {gate.modified ? (
            <>
              <p className="mt-2 text-waiting-foreground">把关时改过：生效的是改过之后的样子。</p>
              <Details id={`knowledge-submitted:${proposal.id}`} title="看提交时的样子">
                <div className="pb-2">
                  <OutputList change={proposal.change} inputs={page.inputs} names={names} />
                  {proposal.change.inputs.length ? <p className="mt-2 text-xs text-muted-foreground wrap-anywhere">{`提交时的输入：${proposal.change.inputs.map((each) => `${entries.find((entry) => entry.id === each.knowledge_id)?.title ?? each.knowledge_id}（${DISPOSITION_LABELS[each.disposition]}）`).join('、')}`}</p> : null}
                </div>
              </Details>
            </>
          ) : null}
        </>
      ) : (
        <p className="wrap-anywhere">{`把关中${task?.reason ? `：${task.reason}` : ''}`}</p>
      )}
      {taskId ? <Link to={`/task/${encodeURIComponent(taskId)}`} className="mt-1 inline-block">看把关任务</Link> : null}
    </section>
  );
}

function Outcome({ proposal }: { proposal: KnowledgeProposal }) {
  const via = proposal.decided_via === null ? '' : VIA_LABELS[proposal.decided_via] ?? proposal.decided_via;
  const decided = proposal.decided_by !== null && (proposal.state === 'published' || proposal.state === 'rejected');
  if (!proposal.state_reason && proposal.state !== 'stale' && !proposal.amended_from && proposal.state !== 'superseded' && !decided) return null;
  return (
    <div className="grid gap-2">
      {proposal.state_reason ? <Note>{proposal.state_reason}</Note> : null}
      {proposal.state === 'stale' ? <Note>它依据的修订已经变了：要按现在的修订重新提。</Note> : null}
      {proposal.amended_from ? <Note>{'这一份是从另一份改来的。'}<Link to={proposalPath(proposal.amended_from)} className="ml-1">看原来那份</Link></Note> : null}
      {proposal.state === 'superseded' ? (
        <Note>
          {'主人把它改成了新的一份，这一份不再生效。'}
          {proposal.next_id ? <Link to={proposalPath(proposal.next_id)} className="ml-1">看新的那份</Link> : null}
        </Note>
      ) : null}
      {decided ? (
        <Callout tone="plain" role="region" aria-label="结果">
          <p className="wrap-anywhere">
            {`${PROPOSAL_STATE_LABELS[proposal.state]}：${proposal.decided_by}${via ? `，经${via}` : ''}，`}
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
  const [note, setNote] = useState('');
  const decide = (decision: 'approve' | 'reject') => action.run(() => post(`/api/knowledge/proposals/${encodeURIComponent(proposal.id)}/decide`, {
    decision,
    // What takes effect, as the owner was shown it: a change that differs is not the one decided.
    digest: proposal.final_digest ?? proposal.digest,
    ...(note.trim() ? { note: note.trim() } : {}),
  }));
  return (
    <Callout tone="waiting" role="region" aria-label="决定" title="决定" className="grid gap-2.5">
      <Textarea aria-label="备注（可不写）" rows={2} className="max-h-[40vh] overflow-y-auto" placeholder="备注（可不写）" value={note} disabled={action.busy} onChange={(event) => setNote(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={action.busy} onClick={() => void decide('approve')}>同意</Button>
        <Button variant="danger" disabled={action.busy} onClick={() => void decide('reject')}>驳回</Button>
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
        title="改成我的修改"
        description="改完直接生效，算你写的、已审阅。涉及的现有条目照旧，按它们现在的修订算；证据和三个回答照旧。"
        {...keepDraft}
        footer={(
          <>
            {action.error ? <Problem role="alert" className="basis-full">{action.error}</Problem> : null}
            <Button variant="primary" disabled={action.busy || unchanged || missing} onClick={() => void save()}>{action.busy ? '保存中' : '保存并生效'}</Button>
            <Button variant="ghost" disabled={action.busy} onClick={onClose}>取消</Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-4">
          {drafts.map((draft, index) => (
            <fieldset key={change.outputs[index]!.key} className={FORM_PART}>
              <legend className={FORM_LEGEND}>{`输出 ${index + 1}`}</legend>
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
      ? <Button disabled={action.busy} onClick={() => { action.clear(); setAmending(true); }}>改成我的修改，直接生效</Button>
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
              <Time at={proposal.created_at} prefix="提于 " />
            </span>
            {proposal.task_id ? <Link to={`/task/${encodeURIComponent(proposal.task_id)}`} className="text-xs">看来源任务</Link> : null}
          </div>
        </header>
        <div className="mt-5 grid grid-cols-1 gap-4">
          {!open && action.error && !drawer ? <Problem role="alert">{action.error}</Problem> : null}
          {open ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-waiting-border bg-waiting-soft/60 px-3.5 py-2 text-xs text-waiting-foreground">
              <span>请先审阅下方内容、差异与证据，再在页尾做出审批决定。</span>
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
                前往审批决策 ↓
              </Button>
            </div>
          ) : null}
          {proposal.state === 'published' && proposal.reviewed_at === null ? (
            <div>
              <Button disabled={action.busy} onClick={() => void action.run(() => post(`/api/knowledge/proposals/${encodeURIComponent(proposal.id)}/review`))}>标已审阅</Button>
            </div>
          ) : null}
          <Outcome proposal={proposal} />
          {proposal.prior_rejection ? (
            <Callout tone="waiting" role="region" aria-label="之前的驳回">
              <p className="wrap-anywhere">
                {`同样的内容之前被驳回过，理由：${proposal.prior_rejection.reason ?? '没有写'}`}
                <Link to={proposalPath(proposal.prior_rejection.id)} className="ml-2">看那一份</Link>
              </p>
            </Callout>
          ) : null}
        </div>
        <div className="mt-8 grid grid-cols-1 gap-8">
          {proposal.owner_reasons.length ? (
            <section aria-label="为什么等你点头" className="text-sm">
              <SectionTitle>为什么要你点头</SectionTitle>
              <ul className="grid gap-0.5">{proposal.owner_reasons.map((reason) => <li key={reason} className="wrap-anywhere">{OWNER_REASON_LABELS[reason]}</li>)}</ul>
            </section>
          ) : null}
          <Gate page={data} names={library} entries={entries} />
          {data.inputs.length ? (
            <section aria-label="输入">
              <SectionTitle>涉及的现有条目</SectionTitle>
              <InputList inputs={data.inputs} change={change} entries={entries} />
            </section>
          ) : null}
          <section aria-label="输出">
            <SectionTitle>{proposal.state === 'published' ? '生效的内容' : '要生效的内容'}</SectionTitle>
            <OutputList change={change} inputs={data.inputs} names={library} />
          </section>
          <section aria-label="差异">
            <SectionTitle>差异</SectionTitle>
            <Changes change={change} inputs={data.inputs} names={library} />
          </section>
          <Impact impact={data.impact} />
          {WHY_KEYS.some((key) => proposal.why[key]) ? (
            <section aria-label="为什么提">
              <SectionTitle>为什么提</SectionTitle>
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
          <section aria-label="证据">
            <SectionTitle>{`证据（${proposal.evidence.length} 条，已核实 ${proposal.evidence.filter((each) => each.verified).length}）`}</SectionTitle>
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
      <PageBar crumbs={[{ label: '知识', to: '/knowledge' }, ...(title ? [{ label: title }] : [])]} />
      <PageBody width="narrow" loading={isPending} failure={error?.message}>{body()}</PageBody>
    </>
  );
}
