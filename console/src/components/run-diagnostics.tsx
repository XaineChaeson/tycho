// Offline self-explaining Run diagnostics drawer: lazy-fetches one Run's diagnostics
// bundle, renders its key findings honestly in Chinese, and offers one-click copy/download.
import { ArrowDownToLine, Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DiagnosticErrorSource, RunDiagnosticsBundle } from '@shared/run-diagnostics.ts';
import { Callout, Details, Fact, Facts, Mono, Note, PRE, Problem, Time } from '@/components/bits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { api, messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const HEADING = 'mt-5 mb-2 flex items-center justify-between gap-2 text-sm font-semibold first:mt-0';

const ERROR_SOURCE_KEYS: Record<DiagnosticErrorSource, string> = {
  diagnostic: 'tsk.diag.errSrc.diagnostic',
  run_error: 'tsk.diag.errSrc.run_error',
  stderr: 'tsk.diag.errSrc.stderr',
};

const ERROR_SOURCE_TONES: Record<DiagnosticErrorSource, BadgeTone> = {
  diagnostic: 'failed',
  run_error: 'failed',
  stderr: 'waiting',
};

const CATEGORY_KEYS: Record<string, string> = {
  read: 'tsk.diag.cat.read',
  edit: 'tsk.diag.cat.edit',
  run: 'tsk.diag.cat.run',
  search: 'tsk.diag.cat.search',
  other: 'tsk.diag.cat.other',
};

function formatDuration(ms: number | null, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (ms === null || !Number.isFinite(ms)) return t('tsk.diag.durationUnknown');
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return t('tsk.diag.durationSec', { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round((seconds % 60) * 10) / 10;
  return t('tsk.diag.durationMinSec', { minutes, seconds: rest });
}

function downloadBundle(runId: string, bundle: RunDiagnosticsBundle): void {
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tycho-run-${runId}-diagnostics.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RunDiagnosticsButton({ runId, round }: { runId: string; round: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [bundle, setBundle] = useState<RunDiagnosticsBundle | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'refused'>('idle');
  const active = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    epoch.current += 1;
    active.current?.abort();
    window.clearTimeout(copyTimer.current);
  }, []);

  async function load(targetRunId: string): Promise<void> {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const generation = ++epoch.current;
    setLoading(true);
    setFailure(null);
    setCopyState('idle');
    try {
      const data = await api<RunDiagnosticsBundle>(
        `/api/runs/${encodeURIComponent(targetRunId)}/diagnostics`,
        { signal: controller.signal },
      );
      if (generation === epoch.current) setBundle(data);
    } catch (error) {
      if (generation === epoch.current && !controller.signal.aborted) {
        setFailure(messageOf(error));
      }
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setBundle(null);
    void load(runId);
  }, [open, runId]);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      epoch.current += 1;
      active.current?.abort();
      setLoading(false);
    }
  }

  async function handleCopy(): Promise<void> {
    if (!bundle) return;
    window.clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(bundle, null, 2)}\n`);
      setCopyState('copied');
      copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('refused');
    }
  }

  const mismatch = Boolean(
    bundle?.models.tier_model
    && bundle.models.reported_models.length > 0
    && !bundle.models.reported_models.includes(bundle.models.tier_model),
  );

  const hasStderr = Boolean(
    bundle && (bundle.stderr.head.length > 0 || bundle.stderr.tail.length > 0),
  );

  const incomplete = Boolean(
    bundle && (
      !bundle.coverage.events_loaded
      || bundle.coverage.dropped_before_index > 0
      || bundle.coverage.incomplete_reason !== null
    ),
  );

  const CopyIcon = copyState === 'copied' ? Check : copyState === 'refused' ? X : Copy;
  const copyLabel = copyState === 'copied' ? t('common.copied') : copyState === 'refused' ? t('tsk.diag.copyFailed') : t('tsk.diag.copyJson');

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" className="mt-2">{t('tsk.diag.triggerBtn')}</Button>
      </SheetTrigger>
      <SheetContent
        title={t('tsk.diag.sheetTitle', { round })}
        description={<Mono>{runId}</Mono>}
        footer={bundle ? (
          <>
            <Button size="sm" onClick={() => void handleCopy()}>
              <CopyIcon className="size-3.5" aria-hidden="true" />
              {copyLabel}
            </Button>
            <Button size="sm" variant="primary" onClick={() => downloadBundle(runId, bundle)}>
              <ArrowDownToLine className="size-3.5" aria-hidden="true" />
              {t('tsk.diag.downloadBtn')}
            </Button>
          </>
        ) : undefined}
      >
        {loading ? (
          <Note>{t('tsk.diag.loading')}</Note>
        ) : failure ? (
          <div className="grid gap-3">
            <Problem>{failure}</Problem>
            <div>
              <Button size="sm" onClick={() => void load(runId)}>{t('common.retry')}</Button>
            </div>
          </div>
        ) : bundle ? (
          <div>
            <section>
              <h3 className={HEADING}>
                <span>{t('tsk.diag.firstErrorTitle')}</span>
                {bundle.first_error ? (
                  <Badge tone={ERROR_SOURCE_TONES[bundle.first_error.source]}>
                    {t(ERROR_SOURCE_KEYS[bundle.first_error.source])}
                  </Badge>
                ) : (
                  <Badge tone="success">{t('tsk.diag.noErrorBadge')}</Badge>
                )}
              </h3>
              {bundle.first_error ? (
                <Callout tone="failed">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {bundle.first_error.event_index !== undefined ? (
                      <Mono>{t('tsk.diag.eventIndex', { index: bundle.first_error.event_index })}</Mono>
                    ) : null}
                    {bundle.first_error.timestamp ? (
                      <Time at={bundle.first_error.timestamp} />
                    ) : null}
                  </div>
                  <p className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                    {bundle.first_error.message}
                  </p>
                </Callout>
              ) : (
                <Note>{t('tsk.diag.noErrorNote')}</Note>
              )}
            </section>

            <section>
              <h3 className={HEADING}>
                <span>{t('tsk.diag.toolsTitle')}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="plain">{t('tsk.diag.toolsTotal', { count: bundle.tools.total })}</Badge>
                  {bundle.tools.error_count > 0 ? (
                    <Badge tone="failed">{t('tsk.diag.toolsFailed', { count: bundle.tools.error_count })}</Badge>
                  ) : null}
                  {bundle.tools.unfinished_count > 0 ? (
                    <Badge tone="waiting">{t('tsk.diag.toolsUnfinished', { count: bundle.tools.unfinished_count })}</Badge>
                  ) : null}
                </span>
              </h3>
              {Object.keys(bundle.tools.by_category).length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {Object.entries(bundle.tools.by_category).map(([category, count]) => (
                    <Badge key={category} tone="ended">
                      {`${CATEGORY_KEYS[category] ? t(CATEGORY_KEYS[category]!) : category} ${count}`}
                    </Badge>
                  ))}
                </div>
              ) : (
                <Note className="text-xs">{t('tsk.diag.noTools')}</Note>
              )}

              {bundle.tools.unfinished_tools.length > 0 ? (
                <div className="mt-2.5">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {t('tsk.diag.unfinishedToolsHeading', { count: bundle.tools.unfinished_count })}
                  </p>
                  <ul className="grid gap-1.5">
                    {bundle.tools.unfinished_tools.map((tool) => (
                      <li
                        key={`${tool.id}:${tool.event_index}`}
                        className="rounded-md border border-waiting-border bg-waiting-soft px-2.5 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Mono className="font-semibold">{tool.name}</Mono>
                          {tool.category ? (
                            <Badge tone="plain">{CATEGORY_KEYS[tool.category] ? t(CATEGORY_KEYS[tool.category]!) : tool.category}</Badge>
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            <Mono>{`#${tool.event_index}`}</Mono>
                          </span>
                        </div>
                        {tool.title ? (
                          <p className="mt-1 text-muted-foreground wrap-anywhere">{tool.title}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {bundle.tools.failed_tools.length > 0 ? (
                <div className="mt-2.5">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {bundle.tools.error_count > bundle.tools.failed_tools.length
                      ? t('tsk.diag.failedToolsHeadingShown', { count: bundle.tools.error_count, shown: bundle.tools.failed_tools.length })
                      : t('tsk.diag.failedToolsHeading', { count: bundle.tools.error_count })}
                  </p>
                  <ul className="grid gap-1.5">
                    {bundle.tools.failed_tools.map((tool, index) => (
                      <li
                        key={`${tool.id ?? tool.name}:${tool.event_index}:${index}`}
                        className="rounded-md border border-failed-border bg-failed-soft px-2.5 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Mono className="font-semibold">{tool.name}</Mono>
                          {tool.exit_code !== undefined ? (
                            <Badge tone="failed">{t('tsk.site.exitCode', { code: tool.exit_code })}</Badge>
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            <Mono>{`#${tool.event_index}`}</Mono>
                          </span>
                        </div>
                        {tool.title ? (
                          <p className="mt-1 text-muted-foreground wrap-anywhere">{tool.title}</p>
                        ) : null}
                        {tool.reason ? (
                          <p className="mt-1 font-mono whitespace-pre-wrap wrap-anywhere">{tool.reason}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>

            <section>
              <h3 className={HEADING}>
                <span>{t('tsk.diag.actualModelTitle')}</span>
                {mismatch ? <Badge tone="waiting">{t('tsk.diag.modelMismatch')}</Badge> : null}
              </h3>
              <Facts>
                <Fact label={t('tsk.diag.executorLabel')}><Mono>{bundle.run.executor}</Mono></Fact>
                <Fact label={t('tsk.diag.tierModelLabel')}>
                  {bundle.models.tier_model ? <Mono>{bundle.models.tier_model}</Mono> : <Note className="text-xs">{t('tsk.diag.undeclared')}</Note>}
                </Fact>
                <Fact label={t('tsk.diag.reportedModelLabel')}>
                  {bundle.models.reported_models.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {bundle.models.reported_models.map((model) => (
                        <Badge key={model} tone="plain"><Mono>{model}</Mono></Badge>
                      ))}
                    </span>
                  ) : (
                    <Note className="text-xs">{t('tsk.diag.notReported')}</Note>
                  )}
                </Fact>
                <Fact label={t('tsk.diag.durationLabel')}>{formatDuration(bundle.run.duration_ms, t)}</Fact>
              </Facts>
            </section>

            <section>
              <h3 className={HEADING}>
                <span>{t('tsk.diag.coverageTitle')}</span>
                <Badge tone={incomplete ? 'waiting' : 'success'}>
                  {incomplete ? t('tsk.diag.coverageGaps') : t('tsk.diag.coverageComplete')}
                </Badge>
              </h3>
              <Callout tone={incomplete ? 'waiting' : 'plain'}>
                <Facts className="text-xs">
                  <Fact label={t('tsk.diag.eventsLoadedLabel')}>{bundle.coverage.events_loaded ? t('tsk.diag.loaded') : t('tsk.diag.notLoaded')}</Fact>
                  <Fact label={t('tsk.diag.eventsIncludedLabel')}>{t('tsk.diag.itemsCount', { count: bundle.coverage.events_count })}</Fact>
                  <Fact label={t('tsk.diag.droppedBeforeLabel')}>{t('tsk.diag.itemsCount', { count: bundle.coverage.dropped_before_index })}</Fact>
                  <Fact label={t('tsk.diag.stderrLabel')}>{bundle.coverage.stderr_loaded ? t('tsk.diag.stderrAttached') : t('tsk.diag.stderrMissing')}</Fact>
                  {bundle.coverage.incomplete_reason ? (
                    <Fact label={t('tsk.diag.incompleteReasonLabel')}>{bundle.coverage.incomplete_reason}</Fact>
                  ) : null}
                </Facts>
              </Callout>
            </section>

            {hasStderr ? (
              <section className="mt-5 border-t border-border pt-3">
                <Details id={`diag-stderr:${runId}`} title={t('tsk.diag.stderrPreviewTitle')}>
                  <div className="mt-2 grid gap-3">
                    {bundle.stderr.head.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          {t('tsk.diag.stderrHead', { count: bundle.stderr.head.length })}
                        </p>
                        <pre className={PRE}>{bundle.stderr.head.join('\n')}</pre>
                      </div>
                    ) : null}
                    {bundle.stderr.tail.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          {t('tsk.diag.stderrTail', { count: bundle.stderr.tail.length })}
                        </p>
                        <pre className={PRE}>{bundle.stderr.tail.join('\n')}</pre>
                      </div>
                    ) : null}
                  </div>
                </Details>
              </section>
            ) : null}

            <Note className="mt-5 border-t border-border pt-3 text-xs">
              {t('tsk.diag.generatedPrefix')}<Time at={bundle.generated_at} />
              {bundle.platform_version ? ` · Tycho ${bundle.platform_version}` : ''}
              {t('tsk.diag.redactedSuffix')}
            </Note>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
