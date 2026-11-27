import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { HistoricalCommit, HistoryEvidence as Evidence, HistoryEvidencePage } from '@shared/history-evidence.ts';
import { exitKindLabels } from '@shared/labels.ts';
import { Details, Mono, Note, Problem, Time } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const commitLabelKeys: Record<HistoricalCommit['source'], string> = {
  reported: 'tsk.history.commit.reported',
  observed: 'tsk.history.commit.observed',
  remote: 'tsk.history.commit.remote',
  pinned: 'tsk.history.commit.pinned',
};

export function HistoryEvidence({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<string | null>(null);
  const evidence = useInfiniteQuery({
    enabled: filters !== null,
    queryKey: ['history-evidence', projectId, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(filters ?? '');
      if (pageParam !== null) params.set('after', pageParam);
      return api<HistoryEvidencePage>(`/api/projects/${encodeURIComponent(projectId)}/history-evidence?${params}`);
    },
    getNextPageParam: (page) => page.next_cursor,
    refetchOnMount: 'always',
  });
  const groups = new Map<string, Evidence[]>();
  for (const item of evidence.data?.pages.flatMap((page) => page.items) ?? []) {
    const rounds = groups.get(item.task_id) ?? [];
    rounds.push(item);
    groups.set(item.task_id, rounds);
  }

  return (
    <section aria-label={t('tsk.history.sectionLabel')} className="grid gap-3">
      <form
        role="search"
        aria-label={t('tsk.history.searchFormLabel')}
        onSubmit={(event) => {
          event.preventDefault();
          const params = new URLSearchParams();
          for (const [key, field] of new FormData(event.currentTarget)) {
            if (typeof field !== 'string' || field.trim() === '') continue;
            params.set(key, key === 'since' || key === 'as_of' ? new Date(field).toISOString() : field.trim());
          }
          const next = params.toString();
          if (next === filters) void evidence.refetch();
          else setFilters(next);
        }}
      >
        <div className="flex items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1 text-sm">
            {t('tsk.history.keywordLabel')}
            <Input name="query" type="search" maxLength={240} placeholder={t('tsk.history.keywordPlaceholder')} />
          </label>
          <Button type="submit"><Search aria-hidden="true" />{t('common.search')}</Button>
        </div>
        <Details id={`history-evidence-filters:${projectId}`} title={t('tsk.history.filtersTitle')} className="mt-1">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">{t('tsk.history.roleIdLabel')}<Input name="role_id" placeholder={t('tsk.history.roleIdPlaceholder')} /></label>
            <label className="grid gap-1 text-sm">{t('tsk.history.commitLabel')}<Input name="commit" pattern="[0-9a-fA-F]{6,64}" placeholder={t('tsk.history.commitPlaceholder')} /></label>
            <label className="grid gap-1 text-sm">{t('tsk.history.sinceLabel')}<Input name="since" type="datetime-local" /></label>
            <label className="grid gap-1 text-sm">{t('tsk.history.asOfLabel')}<Input name="as_of" type="datetime-local" /></label>
          </div>
        </Details>
      </form>
      {filters === null ? <Note>{t('tsk.history.introNote')}</Note> : null}
      {filters !== null && evidence.isPending ? <Note role="status">{t('tsk.history.searching')}</Note> : null}
      {evidence.error ? <Problem role="alert">{evidence.error.message}</Problem> : null}
      {evidence.isSuccess && groups.size === 0 ? (
        <Note role="status">{evidence.hasNextPage ? t('tsk.history.noMatchHasMore') : t('tsk.history.noMatch')}</Note>
      ) : null}
      {groups.size > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {[...groups].map(([taskId, rounds]) => (
            <li key={taskId} className="grid gap-2 px-3 py-3">
              <Link className="wrap-anywhere text-sm font-semibold" to={`/task/${encodeURIComponent(taskId)}`}>
                {rounds[0]?.title ?? t('tsk.history.taskFallbackTitle', { id: taskId })}
              </Link>
              <ul className="grid gap-2">
                {rounds.map((item) => (
                  <li key={item.run_id} className="rounded-lg bg-muted px-2.5 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Time at={item.ended_at} />
                      <span>{item.role_name ?? item.role_id ?? t('tsk.history.roleUnrecorded')}</span>
                      <span>{exitKindLabels[item.exit_kind ?? ''] ?? t('tsk.common.ended')}</span>
                      <Link to={`/task/${encodeURIComponent(taskId)}?run=${encodeURIComponent(item.run_id)}`}>{t('tsk.history.viewRoundLink', { revision: item.task_revision })}</Link>
                    </div>
                    <p className="mt-1 whitespace-pre-line wrap-anywhere">{item.excerpt ?? t('tsk.history.noSummary')}</p>
                    {item.commits.length > 0 ? (
                      <ul aria-label={t('tsk.history.commitEvidenceLabel')} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {item.commits.map(({ value, source }) => <li key={`${source}:${value}`}>{t(commitLabelKeys[source])} <Mono>{value}</Mono></li>)}
                      </ul>
                    ) : null}
                    {item.knowledge && item.knowledge.length > 0 ? (
                      <ul aria-label={t('tsk.history.knowledgeRevisionsLabel')} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {item.knowledge.map(({ id, revision, title }) => (
                          <li key={`${id}:${revision}`}>
                            <Link to={`/knowledge/entries/${encodeURIComponent(id)}?revision=${revision}`}><span className="wrap-anywhere">{title}</span> <Mono>@{revision}</Mono></Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {item.knowledge === null ? <Note className="mt-1 text-xs">{t('tsk.history.noKnowledgeDelivery')}</Note> : null}
                    {item.knowledge_unavailable ? <Note className="mt-1 text-xs">{t('tsk.history.knowledgeUnavailable')}</Note> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {evidence.hasNextPage ? (
        <Button className="justify-self-start" size="sm" onClick={() => void evidence.fetchNextPage()} disabled={evidence.isFetchingNextPage}>
          {evidence.isFetchingNextPage ? t('tsk.common.readingEllipsis') : t('tsk.history.loadEarlier')}
        </Button>
      ) : null}
    </section>
  );
}
