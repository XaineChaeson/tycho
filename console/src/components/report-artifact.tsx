import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Note, Problem } from '@/components/bits';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { ReportContent, ReportDescriptor } from '@/lib/types';

const SOURCE_TEXT: Record<ReportContent['source'], string> = {
  registered: '已登记的产物副本',
  node: '执行节点上的报告',
  settlement: '轮次结算时保存的最后回复',
  recovered: '从历史原输出恢复（本次观察）',
};

export function ReportArtifact({ runId, report, projectId }: { runId: string; report: ReportDescriptor; projectId?: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['run-report', runId, report.ref],
    enabled: open && report.kind !== 'invalid',
    staleTime: 0,
    queryFn: () => api<ReportContent>(`/api/runs/${encodeURIComponent(runId)}/report?ref=${encodeURIComponent(report.ref)}`),
  });
  if (report.kind === 'invalid') return (
    <div className="grid min-w-0 gap-1">
      <span className="break-all">{report.name}</span>
      <Problem role="alert">{report.problem}</Problem>
    </div>
  );
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button type="button" className="min-w-0 text-left underline underline-offset-4" aria-label={`查看报告 ${report.name}`}>{report.name}</button>
      </SheetTrigger>
      {open ? <SheetContent title={report.name}>
        {query.isPending ? <Note role="status">正在读取报告…</Note> : query.error ? (
          <div className="grid gap-3">
            <Problem role="alert">{query.error.message}</Problem>
            <Button onClick={() => void query.refetch()} disabled={query.isFetching}>重新读取</Button>
          </div>
        ) : query.data ? (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <Note>{SOURCE_TEXT[query.data.source]}</Note>
            {'complete' in query.data && !query.data.complete ? <Note className="text-waiting-foreground">仅保存前128KiB，后续内容未保留。</Note> : null}
            <Markdown text={query.data.text} projectId={projectId} />
          </div>
        ) : null}
      </SheetContent> : null}
    </Sheet>
  );
}
