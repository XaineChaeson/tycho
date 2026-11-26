// One entry: the revision in force, every revision before it with its evidence, and the
// owner's own edit or retirement of it (docs/design/knowledge-and-skills.md §3, §5).
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ENTRY_STATE_LABELS, KIND_LABELS, SOURCE_LABELS, citation } from '@shared/knowledge.ts';
import { Callout, Details, Mono, Problem, SectionTitle, Time } from '@/components/bits';
import { EvidenceList, OwnerChangeForm, RetireDialog, SKILL_LOADING_TEXT, draftOf, entryPath, loadingText, proposalPath, reviewText, scopeOf } from '@/components/knowledge-bits';
import { Markdown } from '@/components/markdown';
import { PageBar, PageBody, PageTitle } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { entryQuery, knowledgeQuery } from '@/lib/queries';
import type { KnowledgeEntry, KnowledgeEntryPage, KnowledgePage } from '@/lib/types';

function Retired({ entry, library }: { entry: KnowledgeEntry; library: KnowledgePage | undefined }) {
  const replacement = library?.entries.find((each) => each.id === entry.replaced_by);
  return (
    <Callout tone="plain" role="region" aria-label="退役情况" className="mt-4">
      <p className="wrap-anywhere">{`${entry.retired_by ?? '？'} 退役了它，`}<Time at={entry.retired_at} /></p>
      {entry.retired_reason ? <p className="mt-1 wrap-anywhere">{`理由：${entry.retired_reason}`}</p> : null}
      {entry.replaced_by ? (
        <p className="mt-1 wrap-anywhere">{'替代它的：'}<Link to={entryPath(entry.replaced_by)}>{replacement ? `${replacement.title}（${citation(replacement.id, replacement.revision)}）` : entry.replaced_by}</Link></p>
      ) : null}
    </Callout>
  );
}

// A fact of an entry on its own line: what it is in gray, then what it is now.
const LABEL = 'text-muted-foreground';

function RevisionContents({ revision, library }: { revision: KnowledgeEntryPage['revisions'][number]; library: KnowledgePage | undefined }) {
  return (
    <>
      <p className="font-semibold wrap-anywhere">{revision.title}</p>
      {revision.when_to_use ? <p className="mt-1 wrap-anywhere"><span className={LABEL}>什么时候用：</span>{revision.when_to_use}</p> : null}
      <p className="mt-1 wrap-anywhere"><span className={LABEL}>作用域：</span>{scopeOf(library, revision.project_ids, revision.roles)}</p>
      <p className="mt-1"><span className={LABEL}>加载方式：</span>{loadingText(revision.kind, revision.loading)}</p>
      <Markdown text={revision.body} className="my-2" />
      <p className="text-xs text-muted-foreground wrap-anywhere">
        {`${SOURCE_LABELS[revision.source] ?? revision.source} · ${revision.proposed_by} 提议，${revision.published_by} 发布 · `}
        <Link to={proposalPath(revision.proposal_id)}>看提议</Link>
      </p>
      <h3 className="mt-3 mb-2 text-xs text-faint">证据</h3>
      <EvidenceList evidence={revision.evidence} />
    </>
  );
}

export function EntryPage({ id }: { id: string }) {
  const { data, isPending, error } = useQuery(entryQuery(id));
  // The names scopes are shown by, and the entries that could replace this one.
  const { data: library } = useQuery(knowledgeQuery);
  const [retiring, setRetiring] = useState(false);
  // Come from 待阅's 直接改: the form is what the owner came for.
  const [search] = useSearchParams();
  const [editing, setEditing] = useState(() => search.get('edit') === '1');
  const entry = data?.entry;
  const active = entry?.state === 'active';
  const revisions = [...(data?.revisions ?? [])].sort((a, b) => b.revision - a.revision);
  const others = (library?.entries ?? []).filter((each) => each.state === 'active' && each.id !== id);
  const requested = search.get('revision');

  if (requested !== null) {
    // The owner endpoint decides what the session may read. The URL can only select a revision it returned.
    const revision = revisions.find((each) => String(each.revision) === requested);
    return (
      <>
        <PageBar
          crumbs={[{ label: '知识', to: '/knowledge' }, { label: '历史修订' }]}
          actions={entry ? <Link to={entryPath(entry.id)}>查看当前条目</Link> : undefined}
        />
        <PageBody width="narrow" loading={isPending} failure={error?.message}>
          {data && !revision ? <Problem role="alert">这个修订已不可查看。</Problem> : null}
          {revision ? (
            <section aria-label={`历史修订 ${revision.revision}`}>
              <PageTitle>历史修订 {revision.revision}</PageTitle>
              <p className="mb-4 mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Mono>{citation(revision.id, revision.revision)}</Mono>
                <Time at={revision.published_at} prefix="发布于 " />
                <span>{reviewText(revision.reviewed_at)}</span>
              </p>
              <RevisionContents revision={revision} library={library} />
            </section>
          ) : null}
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageBar
        crumbs={[{ label: '知识', to: '/knowledge' }, ...(entry ? [{ label: entry.title }] : [])]}
        actions={entry && active ? (
          <>
            <Button onClick={() => setEditing(true)}><Pencil />直接改</Button>
            <Button variant="danger" onClick={() => setRetiring(true)}>退役这一条</Button>
          </>
        ) : null}
      />
      <PageBody width="narrow" loading={isPending} failure={error?.message}>
        {data && entry ? (
          <article>
            <header>
              <PageTitle>{entry.title}</PageTitle>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone="plain">{KIND_LABELS[entry.kind]}</Badge>
                <Badge tone={active ? 'plain' : 'ended'}>{ENTRY_STATE_LABELS[entry.state]}</Badge>
                <Badge tone={entry.reviewed_at === null ? 'waiting' : 'plain'}>{reviewText(entry.reviewed_at)}</Badge>
                <Mono className="text-muted-foreground">{citation(entry.id, entry.revision)}</Mono>
                <span className="text-sm text-muted-foreground wrap-anywhere">{scopeOf(library, entry.project_ids, entry.roles)}</span>
              </div>
            </header>
            {active ? null : <Retired entry={entry} library={library} />}

            <section aria-label="现在的内容" className="mt-8">
              <SectionTitle>现在的内容</SectionTitle>
              {entry.when_to_use ? <p className="text-sm wrap-anywhere"><span className={LABEL}>什么时候用：</span>{entry.when_to_use}</p> : null}
              <p className="mt-1 text-sm wrap-anywhere"><span className={LABEL}>加载方式：</span>{entry.kind === 'skill' ? SKILL_LOADING_TEXT : loadingText(entry.kind, entry.loading)}</p>
              <Markdown text={entry.body} className="mt-3 text-base" />
            </section>

            <section aria-label="修订记录" className="mt-8">
              <SectionTitle count={revisions.length}>修订记录</SectionTitle>
              <div className="divide-y divide-border border-y border-border">
                {revisions.map((each) => (
                  <Details
                    key={each.revision}
                    id={`knowledge-revision:${each.id}@${each.revision}`}
                    title={<><span className="text-foreground">{`修订 ${each.revision}`}</span><span>{' · 发布于 '}<Time at={each.published_at} />{` · ${reviewText(each.reviewed_at)}`}</span></>}
                  >
                    <div className="pb-4 pl-5 text-sm">
                      <RevisionContents revision={each} library={library} />
                    </div>
                  </Details>
                ))}
              </div>
            </section>

            {retiring && active ? <RetireDialog entry={entry} others={others} onClose={() => setRetiring(false)} /> : null}
            {editing && active && library ? (
              <OwnerChangeForm
                label="直接改"
                lead="改完就是这一条的新修订，直接生效，算已审阅。"
                names={library}
                initial={draftOf(entry, entry.kind)}
                edits
                // A revision of the revision on the page: one published meanwhile is refused.
                wrap={(output) => ({ inputs: [{ knowledge_id: entry.id, revision: entry.revision, disposition: 'revise' }], outputs: [{ revises: entry.id, ...output }] })}
                onSaved={() => setEditing(false)}
                onClose={() => setEditing(false)}
              />
            ) : null}
          </article>
        ) : null}
      </PageBody>
    </>
  );
}
