import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ROUTER_CALL_RESULT_TEXT, type RouterTurnTrace } from '@shared/trajectory.ts';
import { Details, Mono, Note, PRE, Problem, Time } from '@/components/bits';
import { taskPath } from '@/components/work-row';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const OUTCOME_KEYS = {
  completed: 'proj.traj.outcome.completed',
  failed: 'proj.traj.outcome.failed',
  interrupted: 'proj.traj.outcome.interrupted',
  exited: 'proj.traj.outcome.exited',
  not_sent: 'proj.traj.outcome.not_sent',
} as const;

export function RouterTrajectory({ messageId }: { messageId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    enabled: open,
    queryKey: ['router-trajectory', messageId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<RouterTurnTrace>(`/api/messages/${encodeURIComponent(messageId)}/trajectory${pageParam ? '?after=' + encodeURIComponent(pageParam) : ''}`),
    getNextPageParam: (page) => page.next_call,
    refetchOnMount: 'always',
  });
  const exchanges = query.data?.pages[0]?.exchanges ?? [];
  const calls = query.data?.pages.flatMap((page) => page.calls) ?? [];
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><button type="button" className="text-2xs text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:underline focus-visible:opacity-100">{t('proj.traj.trigger')}</button></SheetTrigger>
      {open ? <SheetContent title={t('proj.traj.sheetTitle')}>
        {query.isPending ? <Note>{t('proj.traj.loading')}</Note> : query.error ? <Problem>{query.error.message}</Problem> : (
          <div className="grid gap-4">
            <section>
              <h3 className="text-sm font-semibold">{t('proj.traj.routerTurnsHeading')}</h3>
              {query.data?.pages[0]?.turn_message_id !== undefined && query.data.pages[0].turn_message_id !== messageId
                ? <Note>{t('proj.traj.batchedNote')}</Note> : null}
              {exchanges.length ? exchanges.map((item) => (
                <Details key={item.id} id={item.id} title={item.phase === 'material' ? t('proj.traj.phaseMaterial') : t('proj.traj.phaseRequest')}>
                  <Note><Time at={item.started_at} /> · {item.outcome ? t(OUTCOME_KEYS[item.outcome]) : t('proj.traj.outcomeUnconfirmed')}</Note>
                  <pre className={PRE}>{item.input}</pre>
                  <Details id={`template:${item.id}`} title={t('proj.traj.viewTemplate')}><pre className={PRE}>{item.template}</pre></Details>
                  <Details id={`tools:${item.id}`} title={t('proj.traj.viewTools')}>
                    {item.tool_catalog ? (
                      <div className="grid gap-3">
                        <Note>{t('proj.traj.toolsNote')}</Note>
                        {item.tool_catalog.tools.map((tool) => (
                          <Details key={tool.name} id={`schema:${item.id}:${tool.name}`} title={tool.name}>
                            <p className="text-sm">{tool.description}</p>
                            <pre className={PRE}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                          </Details>
                        ))}
                      </div>
                    ) : <Note>{t('proj.traj.noToolsSaved')}</Note>}
                  </Details>
                  {item.output === null ? <Note>{t('proj.traj.noOutput')}</Note> : <Details id={`output:${item.id}`} title={t('proj.traj.viewOutput')}><pre className={PRE}>{item.output}</pre></Details>}
                </Details>
              )) : <Note>{t('proj.traj.noExchanges')}</Note>}
            </section>
            <section>
              <h3 className="text-sm font-semibold">{t('proj.traj.toolCallsHeading')}</h3>
              {calls.length ? calls.map((call) => (
                <Details key={call.id} id={call.id} title={call.name}>
                  <Note><Time at={call.started_at} /> · {call.committed.length ? t('proj.traj.committedYes') : t('proj.traj.committedNo')}</Note>
                  <Note>{call.result_state ? ROUTER_CALL_RESULT_TEXT[call.result_state] : t('proj.traj.resultUnconfirmed')} {call.receipt_confirmed ? t('proj.traj.receiptConfirmed') : t('proj.traj.receiptUnknown')}</Note>
                  {call.request === null ? null : <pre className={PRE}>{call.request}</pre>}
                  {call.result === null ? null : <pre className={PRE}>{call.result}</pre>}
                  {[...new Set(call.committed.flatMap(({ task_id }) => task_id === null ? [] : [task_id]))].map((taskId) => (
                    <Link key={taskId} to={taskPath(taskId)} className="block text-sm" onClick={() => setOpen(false)}>{t('proj.traj.viewTask')} <Mono>{taskId}</Mono></Link>
                  ))}
                </Details>
              )) : <Note>{t('proj.traj.noCalls')}</Note>}
              {query.hasNextPage ? <Button size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{t('proj.traj.moreCalls')}</Button> : null}
            </section>
          </div>
        )}
      </SheetContent> : null}
    </Sheet>
  );
}
