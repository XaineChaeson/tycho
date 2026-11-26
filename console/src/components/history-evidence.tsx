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

const commitLabel: Record<HistoricalCommit['source'], string> = {
  reported: '回执报告',
  observed: '机器读取',
  remote: '远端读取',
  pinned: '派发指定',
};

export function HistoryEvidence({ projectId }: { projectId: string }) {
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
    <section aria-label="历史证据" className="grid gap-3">
      <form
        role="search"
        aria-label="搜索历史证据"
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
            关键词
            <Input name="query" type="search" maxLength={240} placeholder="如网络超时、回滚" />
          </label>
          <Button type="submit"><Search aria-hidden="true" />搜索</Button>
        </div>
        <Details id={`history-evidence-filters:${projectId}`} title="按职能、时间或提交号筛选" className="mt-1">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">职能编号<Input name="role_id" placeholder="例如 implement" /></label>
            <label className="grid gap-1 text-sm">提交号<Input name="commit" pattern="[0-9a-fA-F]{6,64}" placeholder="完整提交号或前缀" /></label>
            <label className="grid gap-1 text-sm">结束时间从<Input name="since" type="datetime-local" /></label>
            <label className="grid gap-1 text-sm">结束时间到<Input name="as_of" type="datetime-local" /></label>
          </div>
        </Details>
      </form>
      {filters === null ? <Note>搜索这个项目已结束的轮次，以及当时送达的知识版本。</Note> : null}
      {filters !== null && evidence.isPending ? <Note role="status">正在搜索…</Note> : null}
      {evidence.error ? <Problem role="alert">{evidence.error.message}</Problem> : null}
      {evidence.isSuccess && groups.size === 0 ? (
        <Note role="status">{evidence.hasNextPage ? '已查的轮次中没有匹配，可以继续查更早的轮次。' : '没有找到匹配的轮次。'}</Note>
      ) : null}
      {groups.size > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {[...groups].map(([taskId, rounds]) => (
            <li key={taskId} className="grid gap-2 px-3 py-3">
              <Link className="wrap-anywhere text-sm font-semibold" to={`/task/${encodeURIComponent(taskId)}`}>
                {rounds[0]?.title ?? `任务 ${taskId}`}
              </Link>
              <ul className="grid gap-2">
                {rounds.map((item) => (
                  <li key={item.run_id} className="rounded-lg bg-muted px-2.5 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Time at={item.ended_at} />
                      <span>{item.role_name ?? item.role_id ?? '职能未记录'}</span>
                      <span>{exitKindLabels[item.exit_kind ?? ''] ?? '已结束'}</span>
                      <Link to={`/task/${encodeURIComponent(taskId)}?run=${encodeURIComponent(item.run_id)}`}>查看轮次 · 任务修订 {item.task_revision}</Link>
                    </div>
                    <p className="mt-1 whitespace-pre-line wrap-anywhere">{item.excerpt ?? '未记录摘要。'}</p>
                    {item.commits.length > 0 ? (
                      <ul aria-label="提交证据" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {item.commits.map(({ value, source }) => <li key={`${source}:${value}`}>{commitLabel[source]} <Mono>{value}</Mono></li>)}
                      </ul>
                    ) : null}
                    {item.knowledge && item.knowledge.length > 0 ? (
                      <ul aria-label="轮次知识版本" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {item.knowledge.map(({ id, revision, title }) => (
                          <li key={`${id}:${revision}`}>
                            <Link to={`/knowledge/entries/${encodeURIComponent(id)}?revision=${revision}`}><span className="wrap-anywhere">{title}</span> <Mono>@{revision}</Mono></Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {item.knowledge === null ? <Note className="mt-1 text-xs">没有可确认的知识送达记录。</Note> : null}
                    {item.knowledge_unavailable ? <Note className="mt-1 text-xs">部分历史知识版本已不可查。</Note> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {evidence.hasNextPage ? (
        <Button className="justify-self-start" size="sm" onClick={() => void evidence.fetchNextPage()} disabled={evidence.isFetchingNextPage}>
          {evidence.isFetchingNextPage ? '正在读取…' : '查更早的轮次'}
        </Button>
      ) : null}
    </section>
  );
}
