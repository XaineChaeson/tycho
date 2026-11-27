// 工作: every work of every project. What is not over is listed by where it stands, the
// way the owner asks about it — what waits for them, what moves, what is to be accepted.
// What is over is a list of its own, the most recently ended first, read a page at a time
// and found again by a word of its title, its number or its project.
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ListChecks, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { WORK_GROUP_ORDER, WORK_GROUPS, workGroup } from '@shared/labels.ts';
import { Empty, Note, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import { PageBar, PageBody, PageTabs } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkRow } from '@/components/work-row';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { activeProjects, archivedProjectIds } from '@/lib/projects';
import { PAGE, projectsQuery, tasksQuery } from '@/lib/queries';
import type { EndedWorks, Project } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

function Tabs({ ended }: { ended: boolean }) {
  const { t } = useI18n();
  return (
    <PageTabs
      label={t('tsk.workList.tabsLabel')}
      tabs={[
        { to: '/work', label: t('tsk.workList.tabActive'), current: !ended },
        { to: '/work?show=ended', label: t('tsk.workList.tabEnded'), current: ended },
      ]}
    />
  );
}

function Open({ projects }: { projects: readonly Project[] }) {
  const { t } = useI18n();
  const { data: listing, isPending, error } = useQuery(tasksQuery);
  const archived = archivedProjectIds(projects);
  const works = (listing?.tasks ?? []).filter(
    (task) => workGroup(task) !== WORK_GROUPS.ended && (task.project_id == null || !archived.has(task.project_id)),
  );
  const children = listing?.children ?? [];
  const name = (id: string | null | undefined): string | undefined => projects.find((each) => each.id === id)?.name;
  return (
    <PageBody loading={isPending} failure={error?.message}>
      {works.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-7">
          {WORK_GROUP_ORDER.filter((group) => group !== WORK_GROUPS.ended).map((group) => {
            const members = works.filter((task) => workGroup(task) === group);
            if (!members.length) return null;
            return (
              <section key={group} aria-label={group}>
                <SectionTitle count={members.length}>{group}</SectionTitle>
                <Rows>
                  {members.map((task) => (
                    <WorkRow
                      key={task.id}
                      task={task}
                      project={name(task.project_id)}
                      children={children.filter((child) => child.parent_id === task.id)}
                      meta={<Time at={task.latest_run?.started_at ?? task.updated_at ?? task.created_at} />}
                    />
                  ))}
                </Rows>
              </section>
            );
          })}
        </div>
      ) : <Empty icon={<ListChecks />} title={t('tsk.workList.emptyActiveTitle')}>{t('tsk.workList.emptyActiveBody')}</Empty>}
    </PageBody>
  );
}

function Ended({ projects }: { projects: readonly Project[] }) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  const words = params.get('q') ?? '';
  const [inputValue, setInputValue] = useState(words);

  useEffect(() => {
    setInputValue(words);
  }, [words]);

  // The filter is in the address: a link to "this project's ended work" is one, and the
  // back button undoes a filter.
  const filter = (key: string, value: string): void => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    if (inputValue === words) return undefined;
    const timer = window.setTimeout(() => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (inputValue) next.set('q', inputValue); else next.delete('q');
        return next;
      }, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [inputValue, words, setParams]);

  const query = useInfiniteQuery({
    queryKey: [PAGE, 'ended', project, words.trim()],
    initialPageParam: null as string | null,
    // What was read stays while a new filter is read: the form keeps its place and its focus.
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => {
      const asked = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) asked.set('after', pageParam);
      if (project) asked.set('project', project);
      if (words.trim()) asked.set('q', words.trim());
      return api<EndedWorks>(`/api/tasks/ended?${asked}`);
    },
    // The service says where the next page starts: after the last work read, by when it ended.
    getNextPageParam: (last) => last.next ?? undefined,
  });
  // While a new filter is read, keep the previous rows dimmed instead of flashing a skeleton.
  const reading = query.isPlaceholderData;
  const works = query.data?.pages.flatMap((page) => page.works) ?? [];
  const children = query.data?.pages.flatMap((page) => page.children) ?? [];
  const total = query.data?.pages.at(-1)?.total;
  const name = (id: string | null | undefined): string | undefined => projects.find((each) => each.id === id)?.name;
  // A link to an archived project's ended work keeps saying which project it is: the choice is
  // shown as it was made, marked archived, and cannot be chosen again while archived.
  const archived = projects.find((each) => each.id === project && each.archived_at != null);
  return (
    <PageBody>
      <form
        role="search"
        aria-label={t('tsk.workList.filterFormAria')}
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (inputValue !== words) filter('q', inputValue);
        }}
      >
        <span className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
          <Input
            aria-label={t('tsk.workList.searchPlaceholder')}
            placeholder={t('tsk.workList.searchPlaceholder')}
            className="pl-8"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
          />
        </span>
        <Select aria-label={t('project.defaultTitle')} value={project} onChange={(event) => filter('project', event.target.value)}>
          <Option value="">{t('tsk.workList.allProjects')}</Option>
          {activeProjects(projects).map((each) => <Option key={each.id} value={each.id}>{each.name}</Option>)}
          {archived ? <Option value={archived.id} disabled>{t('tsk.workList.archivedProject', { name: archived.name })}</Option> : null}
        </Select>
        {total !== undefined ? <span className="text-xs text-faint tabular-nums">{t('tsk.workList.totalCount', { total })}</span> : null}
      </form>
      {query.error ? <Problem role="alert" className="mb-3">{query.error.message}</Problem> : null}
      {query.isPending ? <Skeleton className="h-40" /> : works.length ? (
        <Rows className={cn(reading && 'opacity-60 transition-opacity')}>
          <ul aria-label={t('tsk.workList.endedListAria')} aria-busy={reading || undefined} className="divide-y divide-border">
            {works.map((work) => (
              <li key={work.id}>
                <WorkRow
                  task={work}
                  project={project ? undefined : name(work.project_id)}
                  children={children.filter((child) => child.parent_id === work.id)}
                  meta={<Time at={work.summary?.ended_at ?? work.finished_at ?? null} />}
                />
              </li>
            ))}
          </ul>
        </Rows>
      ) : query.error ? null : <Empty title={t('tsk.workList.emptyEndedTitle')}>{t('tsk.workList.emptyEndedBody')}</Empty>}
      {query.hasNextPage ? (
        <div className="mt-3 text-center">
          <Button disabled={reading || query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? t('tsk.workList.loadingMore') : t('tsk.workList.loadMore')}</Button>
        </div>
      ) : null}
      {!query.hasNextPage && works.length > PAGE_SIZE ? <Note className="mt-3 text-center text-xs">{t('tsk.workList.allLoaded')}</Note> : null}
    </PageBody>
  );
}

export function WorkListPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const { data: projects } = useQuery(projectsQuery);
  const ended = params.get('show') === 'ended';
  return (
    <>
      <PageBar title={t('work.title')}><Tabs ended={ended} /></PageBar>
      {ended ? <Ended projects={projects ?? []} /> : <Open projects={projects ?? []} />}
    </>
  );
}
