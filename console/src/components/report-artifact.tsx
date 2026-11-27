import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Note, Problem } from '@/components/bits';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ReportContent, ReportDescriptor } from '@/lib/types';

const SOURCE_KEYS: Record<ReportContent['source'], string> = {
  registered: 'tsk.reportArtifact.source.registered',
  node: 'tsk.reportArtifact.source.node',
  settlement: 'tsk.reportArtifact.source.settlement',
  recovered: 'tsk.reportArtifact.source.recovered',
};

export function ReportArtifact({ runId, report, projectId }: { runId: string; report: ReportDescriptor; projectId?: string }) {
  const { t } = useI18n();
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
        <button type="button" className="min-w-0 text-left underline underline-offset-4" aria-label={t('tsk.reportArtifact.viewLabel', { name: report.name })}>{report.name}</button>
      </SheetTrigger>
      {open ? <SheetContent title={report.name}>
        {query.isPending ? <Note role="status">{t('tsk.reportArtifact.loading')}</Note> : query.error ? (
          <div className="grid gap-3">
            <Problem role="alert">{query.error.message}</Problem>
            <Button onClick={() => void query.refetch()} disabled={query.isFetching}>{t('tsk.reportArtifact.reload')}</Button>
          </div>
        ) : query.data ? (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <Note>{t(SOURCE_KEYS[query.data.source])}</Note>
            {'complete' in query.data && !query.data.complete ? <Note className="text-waiting-foreground">{t('tsk.reportArtifact.truncated128k')}</Note> : null}
            <Markdown text={query.data.text} projectId={projectId} />
          </div>
        ) : null}
      </SheetContent> : null}
    </Sheet>
  );
}
