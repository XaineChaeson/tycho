import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ROUTER_CALL_RESULT_TEXT, type RouterTurnTrace } from '@shared/trajectory.ts';
import { Details, Mono, Note, PRE, Problem, Time } from '@/components/bits';
import { taskPath } from '@/components/work-row';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { api } from '@/lib/api';

const outcomes = {
  completed: '已结束',
  failed: '执行器报告错误',
  interrupted: '已中断',
  exited: '执行器退出',
  not_sent: '未送到执行器',
};

export function RouterTrajectory({ messageId }: { messageId: string }) {
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
      <SheetTrigger asChild><button type="button" className="text-2xs text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:underline focus-visible:opacity-100">查看经过</button></SheetTrigger>
      {open ? <SheetContent title="这条消息的处理经过">
        {query.isPending ? <Note>正在读取…</Note> : query.error ? <Problem>{query.error.message}</Problem> : (
          <div className="grid gap-4">
            <section>
              <h3 className="text-sm font-semibold">负责人回合</h3>
              {query.data?.pages[0]?.turn_message_id !== undefined && query.data.pages[0].turn_message_id !== messageId
                ? <Note>这条事件和同批事件一起交给了负责人。下面是整个回合。</Note> : null}
              {exchanges.length ? exchanges.map((item) => (
                <Details key={item.id} id={item.id} title={item.phase === 'material' ? '项目恢复材料' : '发给负责人的本轮输入'}>
                  <Note><Time at={item.started_at} /> · {item.outcome ? outcomes[item.outcome] : '结果未确认'}</Note>
                  <pre className={PRE}>{item.input}</pre>
                  <Details id={`template:${item.id}`} title="查看固定提示词"><pre className={PRE}>{item.template}</pre></Details>
                  <Details id={`tools:${item.id}`} title="查看 Tycho 工具定义">
                    {item.tool_catalog ? (
                      <div className="grid gap-3">
                        <Note>这回合开始时 Tycho 可提供的工具定义。执行器的接收状态未知。</Note>
                        {item.tool_catalog.tools.map((tool) => (
                          <Details key={tool.name} id={`schema:${item.id}:${tool.name}`} title={tool.name}>
                            <p className="text-sm">{tool.description}</p>
                            <pre className={PRE}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                          </Details>
                        ))}
                      </div>
                    ) : <Note>当时没有保存工具定义。</Note>}
                  </Details>
                  {item.output === null ? <Note>未记录输出。</Note> : <Details id={`output:${item.id}`} title="查看执行器输出"><pre className={PRE}>{item.output}</pre></Details>}
                </Details>
              )) : <Note>没有这条消息的负责人输入记录。</Note>}
            </section>
            <section>
              <h3 className="text-sm font-semibold">Tycho 工具调用</h3>
              {calls.length ? calls.map((call) => (
                <Details key={call.id} id={call.id} title={call.name}>
                  <Note><Time at={call.started_at} /> · {call.committed.length ? '账本已提交操作' : '没有关联的账本提交'}</Note>
                  <Note>{call.result_state ? ROUTER_CALL_RESULT_TEXT[call.result_state] : '调用的返回未确认。'} {call.receipt_confirmed ? '执行器已确认收讫。' : '执行器是否收到未知。'}</Note>
                  {call.request === null ? null : <pre className={PRE}>{call.request}</pre>}
                  {call.result === null ? null : <pre className={PRE}>{call.result}</pre>}
                  {[...new Set(call.committed.flatMap(({ task_id }) => task_id === null ? [] : [task_id]))].map((taskId) => (
                    <Link key={taskId} to={taskPath(taskId)} className="block text-sm" onClick={() => setOpen(false)}>查看任务 <Mono>{taskId}</Mono></Link>
                  ))}
                </Details>
              )) : <Note>没有记录到 Tycho 工具调用。</Note>}
              {query.hasNextPage ? <Button size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>更多调用</Button> : null}
            </section>
          </div>
        )}
      </SheetContent> : null}
    </Sheet>
  );
}
